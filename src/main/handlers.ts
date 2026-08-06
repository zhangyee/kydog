import os from 'node:os';
import { app, dialog, ipcMain } from 'electron';
import { registerHandler } from './ipc/dispatcher';
import { oauthCoordinator } from './llm/oauth';
import { settingsService } from './settings/settingsService';
import { researchService } from './research/researchService';
import { llmService } from './llm/llmService';
import { projectService } from './project/projectService';
import { threadService } from './thread/threadService';
import { skillSyncStateHolder } from './skills/skillSyncStateHolder';
import { skillsService } from './skills/skillsService';
import { toolsService } from './skills/toolsService';
import { fileService } from './fs/fileService';
import { getUpdateService, openDownloadPage } from './update/assemble';
// 从 telemetry/assemble.ts 取，不要从 main.ts —— 后者会造成循环 import
import { getTelemetryService, telemetryStatus } from './telemetry/assemble';
import { getIdentity } from './harness/identityService';
import { onboardingService } from './harness/onboardingService';
import { readManifest, deleteManifest, discardCorruptManifest } from './harness/manifest';
import { mapSystemLocale } from './harness/locale';
import { logger } from './log';
import type { OnboardingRecovery } from '../shared/types';

/** 把刚落盘的遥测选择推给运行中的服务。装配失败时 getTelemetryService() 会抛 ——
 *  统计永远不该让 onboarding 失败，所以这里接住只记日志（与 main.ts 装配处同一约定）。 */
async function syncTelemetryFromSettings(): Promise<void> {
  try {
    await getTelemetryService().syncFromSettings((await settingsService.get()).telemetry);
  } catch (err) {
    logger.warn('telemetry', 'onboarding 后同步遥测状态失败', { err: String(err) });
  }
}

export function registerAllHandlers(): void {
  registerHandler('app.bootstrap', async () => {
    const [settings, projects, threads, identity] = await Promise.all([
      settingsService.get(),
      projectService.list(),
      threadService.listAll(),
      getIdentity(),
    ]);
    let onboardingRecovery: OnboardingRecovery = 'none';
    const m = await readManifest();
    if (settings.onboarding.completedAt === null) {
      if (m.status === 'ok') onboardingRecovery = 'pending';
      else if (m.status === 'corrupt') { await discardCorruptManifest(); onboardingRecovery = 'corrupt-discarded'; }
    } else if (m.status !== 'none') {
      await deleteManifest(); // stale manifest：completed 为准（spec §8）
    }
    return {
      settings, projects, threads,
      appVersion: app.getVersion(),
      systemLocale: mapSystemLocale(app.getLocale()),
      identity, onboardingRecovery,
    };
  });

  registerHandler('onboarding.complete', async (args) => {
    const result = await onboardingService.complete(args);
    // 遥测服务在启动时就装配好了，那会儿状态还是 undecided。onboardingService 只把
    // 用户的勾选写进 settings，运行中的服务对此一无所知 —— 不补这一步，勾选在本次
    // 会话完全不生效（不起调度、不生成 ID，设置页还显示成未勾选）。
    // 读回 settings 而不是直接用 args：manifest/settings 里的 decidedAt 才是权威值。
    if (result.ok) await syncTelemetryFromSettings();
    return result;
  });
  registerHandler('onboarding.resume', async () => {
    // resume 走的是 manifest 里记着的那次勾选，同样要同步。
    const result = await onboardingService.resume();
    if (result.ok) await syncTelemetryFromSettings();
    return result;
  });

  registerHandler('settings.get', () => settingsService.get());
  registerHandler('settings.update', (args) => settingsService.update(args));
  registerHandler('research.get', () => researchService.get());
  registerHandler('research.save', (args) => researchService.save(args));

  registerHandler('update.getStatus', () => getUpdateService().getStatus());
  registerHandler('update.check', () => getUpdateService().check());
  registerHandler('update.setAutoCheck', (args) => getUpdateService().setAutoCheck(args.enabled));
  registerHandler('update.dismissBanner', () => getUpdateService().dismissBanner());
  registerHandler('update.openDownload', async () => {
    // 状态不匹配时报错而非静默忽略，避免 UI 与主进程漂移时产生无声失败
    if (!getUpdateService().canOpenDownload()) throw new Error('当前没有可下载的更新');
    await openDownloadPage();
  });
  registerHandler('update.restartAndInstall', () => { getUpdateService().quitAndInstall(); });

  registerHandler('telemetry.getStatus', () => telemetryStatus());
  registerHandler('telemetry.setEnabled', async (args) => {
    if (args.enabled) await getTelemetryService().enable();
    else await getTelemetryService().disable();
    return telemetryStatus();
  });
  registerHandler('telemetry.deleteMyData', async () => {
    await getTelemetryService().deleteMyData();
    return telemetryStatus();
  });

  registerHandler('project.open', () => projectService.open());
  registerHandler('project.list', () => projectService.list());
  registerHandler('project.close', (args) => projectService.close(args));
  registerHandler('project.readDir', (args) => projectService.readDir(args));
  registerHandler('file.readText', (args) => fileService.readText(args));
  registerHandler('file.readBytes', (args) => fileService.readBytes(args));
  registerHandler('file.writeText', (args) => fileService.writeText(args));
  registerHandler('project.openInOS', (args) => projectService.openInOS(args));
  registerHandler('project.update', (args) => projectService.update(args));

  registerHandler('thread.create', (args) => threadService.create(args));
  registerHandler('thread.list', (args) => threadService.list(args));
  registerHandler('thread.delete', (args) => threadService.delete(args));
  registerHandler('thread.rename', (args) => threadService.rename(args));
  registerHandler('thread.loadHistory', (args) => threadService.loadHistory(args));
  registerHandler('thread.send', (args) => threadService.send(args));
  registerHandler('thread.abort', (args) => threadService.abort(args));
  registerHandler('ask.submit', (args) => threadService.submitAsk(args));
  registerHandler('ask.cancel', (args) => threadService.cancelAsk(args));
  registerHandler('thread.update', (args) => threadService.update(args));

  registerHandler('skill.getPendingSync', () => skillSyncStateHolder.getStatus());
  registerHandler('skill.applyOverrides', async (args) => {
    await skillSyncStateHolder.applyOverrides(args.operations);
    return skillSyncStateHolder.getStatus();
  });

  registerHandler('skill.list', () => skillsService.list());
  registerHandler('skill.setEnabled', (args) => skillsService.setEnabled(args.name, args.enabled));
  registerHandler('skill.uninstall', (args) => skillsService.uninstall(args.name));
  registerHandler('skill.openInOS', (args) => skillsService.openInOS(args.name));
  registerHandler('skill.previewFromFolder', (args) => skillsService.previewFromFolder(args));
  registerHandler('skill.previewFromUrl', (args) => skillsService.previewFromUrl(args));
  registerHandler('skill.commitFromPreview', (args) => skillsService.commitFromPreview(args));
  registerHandler('skill.pickFolder', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: os.homedir(),
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });
  registerHandler('tool.list', (args) => toolsService.list({ force: args?.force }));
  registerHandler('tool.addExternal', () => toolsService.addExternal());
  registerHandler('tool.removeExternal', (args) => toolsService.removeExternal(args));

  registerHandler('llm.list', () => llmService.list());
  registerHandler('llm.configure', (args) => llmService.configure(args));
  registerHandler('llm.remove', (args) => llmService.remove(args.providerId));
  registerHandler('llm.removeCustom', (args) => llmService.removeCustom(args.customId));
  registerHandler('llm.setDefault', (args) => llmService.setDefault(args.providerId, args.modelId));
  registerHandler('llm.setThreadOverride', (args) => llmService.setThreadOverride(args.threadId, args.override));
  registerHandler('llm.testConnection', (args) => llmService.testConnection(args.providerId));

  // OAuth — Phase 5
  registerHandler('llm.login', (args) => oauthCoordinator.login(args.providerId));
  registerHandler('llm.loginCancel', async (args) => oauthCoordinator.cancel(args.providerId));
  registerHandler('llm.loginPromptReply', async (args) => oauthCoordinator.promptReply(args.providerId, args.value));
  registerHandler('llm.logout', async (args) => {
    await oauthCoordinator.logout(args.providerId);
    const { llmService } = await import('./llm/llmService');
    return llmService.list();
  });

  registerHandler('dialog.pickFile', async (args) => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: args?.filters,
      defaultPath: os.homedir(),
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  if (process.env.KYDOG_E2E === '1') {
    ipcMain.handle('kydog:debug:envSnapshot', async () => {
      const keys = [
        'AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_RESOURCE_NAME', 'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
        'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION', 'AWS_BEDROCK_FORCE_CACHE',
        'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS',
      ];
      const snap: Record<string, string | null> = {};
      for (const k of keys) snap[k] = process.env[k] ?? null;
      return snap;
    });
  }
}
