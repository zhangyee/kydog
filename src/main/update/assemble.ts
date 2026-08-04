import { app, shell } from 'electron';
import { settingsService } from '../settings/settingsService';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { UpdateService } from './updateService';
import { createScheduler } from './scheduler';
import {
  createDarwinEngine, createWin32Engine, createNoopEngine, createFixtureEngine,
  type CheckEngine,
} from './engine';
import { createElectronUpdaterPort } from './updaterPort';
import { pickAssembly } from './pickAssembly';
import {
  buildFeedUrl, RELEASES_LATEST_URL,
  FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS, CHECK_DEADLINE_MS,
} from './constants';


let service: UpdateService | null = null;

export function getUpdateService(): UpdateService {
  if (!service) throw new Error('更新服务尚未初始化');
  return service;
}

export async function initUpdateService(): Promise<void> {
  const mode = pickAssembly({
    isPackaged: app.isPackaged,
    e2e: process.env.KYDOG_E2E,
    fixture: process.env.KYDOG_UPDATE_FIXTURE,
  });
  const version = app.getVersion();
  const userAgent = `KyDog/${version} (${process.platform}: ${process.arch})`;
  const feedUrl = buildFeedUrl(process.platform, process.arch, version);

  let engine: CheckEngine;
  if (mode === 'fixture') engine = createFixtureEngine(process.env.KYDOG_UPDATE_FIXTURE!);
  else if (mode === 'noop') engine = createNoopEngine();
  else if (process.platform === 'win32') {
    engine = createWin32Engine({ port: createElectronUpdaterPort(), feedUrl, userAgent, deadlineMs: CHECK_DEADLINE_MS });
  } else {
    engine = createDarwinEngine({ feedUrl, userAgent });
  }

  const settings = await settingsService.get();
  let scheduler: ReturnType<typeof createScheduler>;

  service = new UpdateService({
    engine,
    currentVersion: version,
    // 与 createWin32Engine 用同一个常量是刻意的：service 侧的 AbortController
    // 在 Windows 上是空转的（引擎自己计时且不理会 signal），两者必须同步。
    deadlineMs: CHECK_DEADLINE_MS,
    initialAutoCheck: settings.updates.autoCheck,
    initialDismissedCandidateId: settings.updates.dismissedCandidateId,
    // 写盘走公开的 withLock，其回调运行在队列任务与文件锁内部。
    // updates 一节已从 SettingsPatch 排除，没有第二个写者。
    persistAutoCheck: async (enabled) => {
      await settingsService.withLock(async (cur) => ({
        next: { ...cur, updates: { ...cur.updates, autoCheck: enabled } },
        result: undefined,
      }));
    },
    persistDismissed: async (candidateId) => {
      await settingsService.withLock(async (cur) => ({
        next: { ...cur, updates: { ...cur.updates, dismissedCandidateId: candidateId } },
        result: undefined,
      }));
    },
    onStatusChange: (status) => broadcaster.emit('update.status', status),
    onAutoCheckChanged: (enabled) => scheduler.reconfigure(enabled),
  });

  scheduler = createScheduler({
    run: () => getUpdateService().check(),
    firstDelayMs: FIRST_CHECK_DELAY_MS,
    intervalMs: CHECK_INTERVAL_MS,
  });
  scheduler.reconfigure(settings.updates.autoCheck);
  logger.info('update', 'update service ready', { mode, platform: process.platform });
}

export function openDownloadPage(): Promise<void> {
  return shell.openExternal(RELEASES_LATEST_URL);
}
