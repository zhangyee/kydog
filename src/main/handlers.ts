import os from 'node:os';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { registerHandler } from './ipc/dispatcher';
import { sinkFor } from './ipc/broadcaster';
import { viewStateStore } from './ui/viewState';
import { TITLE_BAR_HEIGHT } from './windowChrome';
import { oauthCoordinator } from './llm/oauth';
import { settingsService, toRendererSettings } from './settings/settingsService';
import { researchService } from './research/researchService';
import { llmService } from './llm/llmService';
import { projectService } from './project/projectService';
import { fileWatcherService } from './project/fileWatcher';
import { threadService } from './thread/threadService';
import { skillSyncStateHolder } from './skills/skillSyncStateHolder';
import { skillsService } from './skills/skillsService';
import { withSkillTree } from './skills/skillTreeLock';
import { createLocaleSet } from './skills/localeSet';
import { agentService } from './agent/AgentService';
import { browserService } from './browser/browserService';
import { institutionService } from './institution/institutionService';
import { toolsService } from './skills/toolsService';
import { fileService } from './fs/fileService';
import { renderPageToPng } from './pdf/pdfRaster';
import { pdfAnnotations } from './pdf/pdfAnnotations';
import { pdfTranslation } from './pdf/pdfTranslation';
import { layoutPage, translateGroups } from './pdf/pdfTranslatePage';
import { getUpdateService, openDownloadPage } from './update/assemble';
// 从 telemetry/assemble.ts 取，不要从 main.ts —— 后者会造成循环 import
import { getTelemetryService, telemetryStatus } from './telemetry/assemble';
import { getIdentity } from './harness/identityService';
import { onboardingService } from './harness/onboardingService';
import { harnessService } from './harness/harnessService';
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

/** 注意这里全部接的是**无锁**入口：外层 registerHandler 已经用 withSkillTree 包住整个事务，
 *  再走 runFor() / list() 那两个加锁壳就是重入死锁。 */
const localeSet = createLocaleSet({
  currentLocale: async () => (await settingsService.get()).ui.locale,
  hasActiveRun: () => agentService.hasActiveRun(),
  disposeAllSessions: () => agentService.disposeAllSessions(),
  sync: (locale, phase) => skillSyncStateHolder.runForUnlocked(locale, phase),
  commitLocale: (locale) => settingsService.update({ ui: { locale } }),
  readSettings: () => settingsService.get(),
  listSkills: () => skillsService.listUnlocked(),
});

/** 已经挂过 destroyed 监听的窗口（`fs.setWatched` 用），每个窗口只挂一次。 */
const watchSenders = new Set<number>();

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
      // 不是原样的 settings：密文不过河，见 toRendererSettings
      settings: toRendererSettings(settings), projects, threads,
      appVersion: app.getVersion(),
      systemLocale: mapSystemLocale(app.getLocale()),
      identity, onboardingRecovery,
      // 只有渲染进程重载时这里才非空 —— 主进程内存里的东西，冷启动是干净的。
      viewState: viewStateStore.get(),
      // 上一行 `settingsService.get()` 刚读过盘，这里拿的就是那一次的判据 ——
      // 不重读，否则横幅说的可能不是「你现在用的这份设置是怎么来的」。
      settingsHealth: settingsService.settingsHealth(),
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

  registerHandler('harness.status', () => harnessService.status());
  registerHandler('harness.apply', (args) => harnessService.apply(args.choices, args.source));
  registerHandler('harness.read', (args) => harnessService.read(args.name));
  registerHandler('harness.write', (args) => harnessService.write(args));

  registerHandler('ui.saveViewState', (args) => { viewStateStore.set(args.state); });

  registerHandler('settings.get', async () => toRendererSettings(await settingsService.get()));
  registerHandler('settings.update', async (args) => toRendererSettings(await settingsService.update(args)));
  registerHandler('research.get', () => researchService.get());
  registerHandler('research.save', (args) => researchService.save(args));

  // ── 内置浏览器（侧栏那条路）──
  // 这九条与 agent 那三个工具动的是**同一个** browserService。跨路的并发由
  // browserService 自己的按标签串行队列收口（见那里的 `enqueue`）——
  // 这一层不许自己再造一条路。
  //
  // `open` 显式投影而不是把 args 整个递进去：`BrowserService.open` 还收一个
  // `ownerThreadId`，那是「这个标签属于哪个对话、受 agent 标签上限与对话删除管」的记账字段。
  // 类型上渲染层给不出它，但类型挡不住运行时 —— 渲染层发来的东西一律当输入看，
  // 只取协议上写明的那两个字段。**从这条路开的标签永远是用户的。**
  // 用户在地址栏开页面：要看的就是这一页，**显式**切过去。`open` 默认不抢活动标签 ——
  // agent 的 browser_open 走的是默认，不切走用户正在看的页面。
  // 返回值同样显式投影回协议上的 `{ tabId, nav }`：`evicted` 里带着主进程的归属记账（ownerThreadId），
  // 不该随 RPC 上线（从这条路开的是用户标签，它本来也恒为空）。
  registerHandler('browser.open', (args) => browserService.open({ url: args.url, tabId: args.tabId, activate: true })
    .then(({ tabId, nav }) => ({ tabId, nav })));
  registerHandler('browser.newTab', () => browserService.openBlank());
  registerHandler('browser.close', (args) => { browserService.close(args.tabId); });
  registerHandler('browser.keep', (args) => { browserService.keep(args.tabId); });
  registerHandler('browser.activate', (args) => { browserService.activate(args.tabId); });
  registerHandler('browser.navControl', (args) => browserService.navControl(args.tabId, args.action));
  // **顺带签发一个新 epoch。** 协议上没有第二条 RPC 能给渲染层新 epoch，而
  // 没有 epoch 渲染层的 syncView 全部会被判过期丢掉 —— 侧栏里那块网页永远拿不到
  // bounds、一直不可见，直到下一次真实标签变更才恢复。恢复顺序是「先订阅、
  // 后 getState、按 revision 去旧」，所以签发必须排在返回快照**之前**：
  // 返回的这一份自己就带着新 epoch。
  registerHandler('browser.getState', () => {
    browserService.newEpoch();
    return browserService.getState();
  });
  registerHandler('browser.syncView', (args) => { browserService.syncView(args); });
  registerHandler('browser.setViewportMode', (args) => { browserService.setViewportMode(args.tabId, args.mode); });

  // ── CARSI 机构账号 ──
  // 密码只往一个方向流：`get` / `save` 回的都是 InstitutionPublic（只有 hasPassword
  // 一个比特），明文只在 `revealPassword` 这一条显式往返上回一次。
  // **别在这里开第五条出口** —— 回整份 settings 的那四条已经收窄成 toRendererSettings。
  registerHandler('institution.get', () => institutionService.get());
  registerHandler('institution.save', (args) => institutionService.save(args));
  registerHandler('institution.clear', () => institutionService.clear());
  // RPC 叫 revealPassword，服务上的方法叫 `reveal()` —— 名字对不上是继承的，别照名字猜。
  registerHandler('institution.revealPassword', () => institutionService.reveal());
  registerHandler('institution.listIdps', (args) => institutionService.listIdps({ refresh: args?.refresh }));

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
  // 按窗口分账：窗口没了就把它那份撤掉，不然它最后声明的那些目录会一直开着句柄。
  // 同一个窗口重载不算「没了」—— 新页面启动时会先声明一份（空的也发），整份替换掉旧的。
  registerHandler('fs.setWatched', (args, evt) => {
    const id = evt.sender.id;
    if (!watchSenders.has(id)) {
      watchSenders.add(id);
      evt.sender.once('destroyed', () => {
        watchSenders.delete(id);
        fileWatcherService.forget(id);
      });
    }
    fileWatcherService.set(id, args);
  });
  registerHandler('file.readText', (args) => fileService.readText(args));
  registerHandler('file.readBytes', (args) => fileService.readBytes(args));
  registerHandler('file.readBytesWithin', (args) => fileService.readBytesWithin(args));
  registerHandler('file.writeText', (args) => fileService.writeText(args));
  registerHandler('pdf.renderPage', (args) => renderPageToPng(args));
  registerHandler('pdf.annotations.load', (args) => pdfAnnotations.load(args));
  registerHandler('pdf.annotations.save', (args) => pdfAnnotations.save(args));
  registerHandler('pdf.translation.load', (args) => pdfTranslation.load(args));
  registerHandler('pdf.translation.resolveModel', (args) => pdfTranslation.resolveModel(args));
  registerHandler('pdf.translation.layout', (args) => layoutPage(args));
  registerHandler('pdf.translation.translate', (args) => translateGroups(args));
  registerHandler('pdf.translation.save', (args) => pdfTranslation.save(args));
  registerHandler('pdf.translation.delete', (args) => pdfTranslation.delete(args));
  registerHandler('project.openInOS', (args) => projectService.openInOS(args));
  registerHandler('project.update', (args) => projectService.update(args));

  registerHandler('thread.create', (args) => threadService.create(args));
  registerHandler('thread.list', (args) => threadService.list(args));
  registerHandler('thread.delete', (args) => threadService.delete(args));
  registerHandler('thread.archive', (args) => threadService.archive(args));
  registerHandler('thread.unarchive', (args) => threadService.unarchive(args));
  registerHandler('thread.rename', (args) => threadService.rename(args));
  registerHandler('thread.loadHistory', (args, evt) => threadService.loadHistory(args, sinkFor(evt.sender)));
  registerHandler('thread.send', (args) => threadService.send(args));
  registerHandler('thread.abort', (args) => threadService.abort(args));
  registerHandler('ask.submit', (args) => threadService.submitAsk(args));
  registerHandler('ask.cancel', (args) => threadService.cancelAsk(args));
  registerHandler('thread.update', (args) => threadService.update(args));

  // 整个事务在一把 skillTreeLock 里跑完：dispose session → 换树 → 提交 locale。
  // 期间任何 skill 读写入口都排在后面，不会看到半换的树。
  registerHandler('locale.set', async (args) => {
    const r = await withSkillTree(() => localeSet(args.locale));
    return { ...r, settings: toRendererSettings(r.settings) };
  });

  registerHandler('skill.getSyncHealth', () => skillSyncStateHolder.getHealth());

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

  // Windows 的窗口按钮是原生叠加层，颜色只能由主进程设；而主题色的真源在渲染层的
  // theme CSS，所以由 ThemeApplier 落完 data-theme 后推过来。height 每次一并带上，
  // 免得它和 TitleBar 的 h-9 悄悄错开。非 win32 没有 overlay，调它会抛，直接不做。
  registerHandler('window.setTitleBarOverlay', (args, evt) => {
    if (process.platform !== 'win32') return;
    BrowserWindow.fromWebContents(evt.sender)?.setTitleBarOverlay({ ...args, height: TITLE_BAR_HEIGHT });
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
