import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import started from 'electron-squirrel-startup';
import { ROOT, SESSIONS_DIR, LOGS_DIR } from './persist/paths';
import { installDispatcher } from './ipc/dispatcher';
import { registerAllHandlers } from './handlers';
import { logger } from './log';
import { binDir } from './bin/binPath';
import { prependBinDirToPath } from './bin/pathEnv';
import { detectBashOnWindows } from './bin/shellCheck';
import { skillSyncStateHolder } from './skills/skillSyncStateHolder';

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

async function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
  if (!app.isPackaged) mainWindow.webContents.openDevTools({ mode: 'detach' });
}

app.on('ready', async () => {
  try {
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

    await skillSyncStateHolder.runOnStartup();

    installDispatcher();
    registerAllHandlers();
    await createWindow();
    logger.info('app', 'ready');
  } catch (err) {
    logger.error('app', 'startup failed', { err: String(err) });
    dialog.showErrorBox('KyDog failed to start', String(err));
    app.quit();
  }
});

app.on('window-all-closed', () => { app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
