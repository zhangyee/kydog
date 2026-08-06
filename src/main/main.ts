import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import started from 'electron-squirrel-startup';
import { ROOT, SESSIONS_DIR, LOGS_DIR, STAGING_DIR } from './persist/paths';
import { installDispatcher } from './ipc/dispatcher';
import { registerAllHandlers } from './handlers';
import { logger } from './log';
import { binDir } from './bin/binPath';
import { prependBinDirToPath } from './bin/pathEnv';
import { detectBashOnWindows } from './bin/shellCheck';
import { skillSyncStateHolder } from './skills/skillSyncStateHolder';
import { settingsService } from './settings/settingsService';
import { ensureSettingsFile } from './persist/settingsFile';
import { applyCloudEnv } from './llm/cloudEnvSync';
import { applyResearchEnv } from './research/researchEnv';
import { initProviderRegistry } from './llm/providerRegistry';
import { projectService } from './project/projectService';
import { fileWatcherService } from './project/fileWatcher';
import { startIdentityWatcher } from './harness/identityService';
import { initUpdateService } from './update/assemble';
import { assembleTelemetry } from './telemetry/assemble';
import { broadcaster } from './ipc/broadcaster';

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

// 打包后 macOS .icns / Windows .ico 由 forge packagerConfig.icon 烧进 bundle，
// 开发模式 Electron 默认显示自带 logo —— 这里仅为 dev 模式补上 dock / 任务栏图标。
const DEV_ICON_PATH = path.join(__dirname, '../../assets/icons/icon.png');

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: app.isPackaged || process.platform === 'darwin' ? undefined : DEV_ICON_PATH,
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
  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.on('ready', async () => {
  try {
    if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(DEV_ICON_PATH);
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

    try {
      await skillSyncStateHolder.runOnStartup();
    } catch (err) {
      logger.warn('skill-sync', 'startup sync failed; continuing without builtin skills', { err: String(err) });
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
    try {
      await projectService.initWatchers();
    } catch (err) {
      logger.warn('app', 'file watcher init failed', { err: String(err) });
    }
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

app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
app.on('before-quit', () => { void fileWatcherService.stopAll(); });
