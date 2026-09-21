import { app, BrowserWindow, dialog, nativeImage, session, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import started from 'electron-squirrel-startup';
import { ROOT, SESSIONS_DIR, LOGS_DIR, STAGING_DIR } from './persist/paths';
import { installDispatcher } from './ipc/dispatcher';
import { registerAllHandlers } from './handlers';
import { logger } from './log';
import { windowChrome } from './windowChrome';
import { installAppMenu } from './menu';
import { binDir } from './bin/binPath';
import { prependBinDirToPath } from './bin/pathEnv';
import { detectBashOnWindows } from './bin/shellCheck';
import { skillSyncStateHolder } from './skills/skillSyncStateHolder';
import { settingsService } from './settings/settingsService';
import { ensureSettingsFile } from './persist/settingsFile';
import { applyCloudEnv } from './llm/cloudEnvSync';
import { applyResearchEnv } from './research/researchEnv';
import { initProviderRegistry, setCatalogRefreshedHook } from './llm/providerRegistry';
import { llmService } from './llm/llmService';
import { fileWatcherService } from './project/fileWatcher';
import { destroyRasterWindow } from './pdf/pdfRaster';
import { startIdentityWatcher } from './harness/identityService';
import { initUpdateService } from './update/assemble';
import { assembleTelemetry } from './telemetry/assemble';
import { broadcaster } from './ipc/broadcaster';
import { browserService } from './browser/browserService';
import { installProxyDispatcher } from './net/systemProxy';
import { installBrowserWindowWiring, installBrowserQuitWiring } from './browser/mainWiring';
import iconDataUrl from '../../assets/icons/icon.png?inline';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

if (started) app.quit();

async function ensureKydogDirs() {
  await Promise.all([
    fs.mkdir(ROOT, { recursive: true }),
    fs.mkdir(SESSIONS_DIR, { recursive: true }),
    fs.mkdir(LOGS_DIR, { recursive: true }),
  ]);
}

// Windows 任务栏按钮优先用**窗口自己的**图标（WM_GETICON），没有才回落去读 exe 里的图标
// 资源。打包版原先不设窗口图标，任务栏只能拿 .ico 里预先烤死的小帧，肉眼明显比开发模式糊。
// 实测（Electron 41 / win32）：dev 的窗口 ICON_BIG = 1024x1024，打包版为「无」。
// 所以两种模式一律设同一张 1024 源图，让 Windows 按它实际需要的尺寸一次性缩放 —— 这比在
// .ico 里猜它要哪一档可靠：任务栏究竟请求多大由外壳决定，进程外观测不到。
//
// 用 ?inline 打成 data URI 而不是读文件：打包后 __dirname 落在 asar 内，相对路径解析不到
// assets/。39KB 的图，进包代价可以忽略。
const APP_ICON = nativeImage.createFromDataURL(iconDataUrl);

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    ...windowChrome(process.platform),
    icon: process.platform === 'darwin' ? undefined : APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Route all external links (target="_blank" + plain anchor navigations) through
  // the OS default browser. Same-origin navigations (Vite HMR reload, in-app
  // file:// loads) pass through. Non-http(s)/mailto schemes are silently denied
  // to avoid handing arbitrary URIs to the OS.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (/^(https?|mailto):$/.test(parsed.protocol)) void shell.openExternal(url);
    } catch { /* ignore malformed url */ }
    return { action: 'deny' };
  });
  // 内置浏览器装配到这个窗口上：网页由主进程持有的 WebContentsView 承载，
  // 渲染层只画一块空「舞台」div 并上报几何。同时挂上「渲染层重载 / 渲染进程没了
  // 就先把网页藏起来」——那两个时刻拿不到可靠的最后一次 syncView。
  // 三处接线为什么拆在那个模块里，见 mainWiring.ts。
  installBrowserWindowWiring(mainWindow, browserService);
  mainWindow.webContents.on('will-navigate', (e, targetUrl) => {
    let target: URL;
    try { target = new URL(targetUrl); } catch { e.preventDefault(); return; }
    const current = new URL(mainWindow.webContents.getURL());
    if (target.origin === current.origin) return;
    e.preventDefault();
    if (/^(https?|mailto):$/.test(target.protocol)) void shell.openExternal(targetUrl);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    const indexPath = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
    try {
      await mainWindow.loadFile(indexPath);
    } catch (err) {
      // Transient ERR_FAILED (-2) can happen when a previous Electron process
      // just released the file (e.g. e2e relaunching the app). Wait a tick
      // and retry once before bubbling up.
      await new Promise((r) => setTimeout(r, 200));
      logger.warn('app', 'loadFile retry after transient failure', { err: String(err) });
      await mainWindow.loadFile(indexPath);
    }
  }
  // e2e 跑的也是未打包的 .vite/build/main.js，会走到这里；但 e2e 里不能开这个分离窗口。
  // macOS 上它在 load 后约 180ms 变成 key window，主窗口随即 blur：渲染层
  // document.hasFocus() 变 false，而 document.activeElement 不变。Playwright 的
  // toBeFocused 判的是「activeElement 相等 **且** hasFocus 为 true」，且它的轮询不带任何
  // 输入刺激；一旦这次 blur 落在最后一次点击之后、断言首轮之前，5s 内就再没有东西把渲染层
  // 焦点拉回来（任何一次 CDP 输入——哪怕 mousemove——都能拉回，所以后续 fill/press 不受影响，
  // 只有 toBeFocused 这种纯观察断言会红）。34-thread-rename / 18-projects-sidebar 的
  // 「输入框应该获得焦点」间歇失败就是它；以前 index.html 里那个 Google Fonts 的 link 把 load
  // 拖后 2–4s，React 挂载反而排在 load 之后，blur 于是落在用例第一次交互之前、被首次 hover
  // 顺手拉回，掩盖了整件事（2026-09-05 用主进程/渲染层焦点时间线钉死）。守这条的是 00-shell。
  if (!app.isPackaged && process.env.KYDOG_E2E !== '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.on('ready', async () => {
  try {
    // 让主进程的 HTTP 跟内置浏览器走同一条路：系统代理 / PAC / bypass 全由 Chromium 解析。
    // 位置是硬的，两头都卡死：`session.resolveProxy` 在 ready 之前会抛「Session can only be
    // received when app is ready」；而往后挪一点，`initProviderRegistry` 的后台目录刷新就先飞
    // 出去了，那批请求会漏掉代理。放在 ready 的第一行最省心。细节见 net/systemProxy.ts。
    try {
      installProxyDispatcher({ resolveProxy: (url) => session.defaultSession.resolveProxy(url) });
    } catch (err) {
      // 出网配置永远不能打断启动：装不上就退回直连（和这次改动之前的行为一致）。
      logger.warn('net', 'proxy dispatcher install failed; continuing direct', { err: String(err) });
    }

    if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(APP_ICON);
      } catch (err) {
        logger.warn('app', 'failed to set dev dock icon', { err: String(err) });
      }
    }
    if (process.platform === 'win32') {
      const { found, searched } = detectBashOnWindows();
      if (!found) {
        const choice = dialog.showMessageBoxSync({
          type: 'warning',
          message: 'KyDog 需要 Git for Windows',
          detail:
            `KyDog 的 AI 助手依赖 Git for Windows 自带的 Bash 来执行命令。当前系统上没找到。\n\n` +
            `搜索过的位置:\n${searched.map((s) => '  • ' + s).join('\n')}`,
          buttons: ['打开 Git 下载页', '仍要继续（Agent 会无法工作）'],
          defaultId: 0, cancelId: 1,
        });
        if (choice === 0) {
          await shell.openExternal('https://git-scm.com/download/win');
          app.quit();
          return;
        }
      }
    }

    prependBinDirToPath(binDir());

    await ensureKydogDirs();
    ensureSettingsFile();

    const _initialSettings = await settingsService.get();
    applyCloudEnv(_initialSettings.llm.providers);
    applyResearchEnv(_initialSettings.research);
    // 必须排在 initProviderRegistry 之前：build() 里那次后台目录刷新就是从它开始飞的。
    setCatalogRefreshedHook(() => {
      void llmService.list()
        .then((r) => broadcaster.emit('llm.listChanged', r))
        .catch((err) => logger.warn('llm', 'catalog broadcast failed', { err: String(err) }));
    });
    await initProviderRegistry(settingsService);

    try {
      const settings = await settingsService.get();
      const externalDirs = new Set(settings.tools.externalBins.map((b) => path.dirname(b.path)));
      for (const d of externalDirs) prependBinDirToPath(d);
    } catch (err) {
      logger.warn('app', 'external bin PATH inject failed', { err: String(err) });
    }

    await fs.rm(STAGING_DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(STAGING_DIR, { recursive: true }).catch(() => {});

    // onboarding 未完成时 locale 还不存在，跳过；由 onboardingService 在用户选定后播种。
    // 此时 Root.tsx 不渲染 AppShell，skills UI 不可达，跳过没有可观测副作用。
    if (_initialSettings.onboarding.completedAt !== null) {
      await skillSyncStateHolder.runFor(_initialSettings.ui.locale, 'startup');
    }

    installDispatcher();
    registerAllHandlers();
    try {
      await initUpdateService();
    } catch (err) {
      // 更新服务永远不能打断启动
      logger.warn('update', 'init failed; continuing without update checks', { err: String(err) });
    }
    try {
      assembleTelemetry((await settingsService.get()).telemetry);
    } catch (err) {
      // 统计永远不能打断启动
      logger.warn('telemetry', 'assemble failed; continuing without telemetry', { err: String(err) });
    }
    startIdentityWatcher((id) => broadcaster.emit('identity.changed', id));
    installAppMenu();
    await createWindow();
    logger.info('app', 'ready');
  } catch (err) {
    logger.error('app', 'startup failed', { err: String(err) });
    if (process.env.KYDOG_E2E !== '1') {
      dialog.showErrorBox('KyDog failed to start', String(err));
    }
    app.quit();
  }
});

// 内置浏览器的标签退出时一并收摊。挂在 before-quit（不是窗口 `closed`）：
// 那里只清窗口引用，收摊统一在这里做一次，`disposeAll` 本身幂等。
installBrowserQuitWiring(app, browserService);

app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
app.on('before-quit', () => {
  fileWatcherService.stopAll();
  // PDF 渲染窗口用完即毁，正常不会活到这里；退出时还在飞的那一个由这句收掉。
  destroyRasterWindow();
});
