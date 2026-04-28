import { app, BrowserWindow, dialog } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import started from 'electron-squirrel-startup';
import { ROOT, SESSIONS_DIR, LOGS_DIR } from './persist/paths';
import { installDispatcher } from './ipc/dispatcher';
import { registerAllHandlers } from './handlers';
import { logger } from './log';

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
      preload: path.join(__dirname, '../preload/index.js'),
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
    await ensureKydogDirs();
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

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
