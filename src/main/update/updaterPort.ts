import { autoUpdater } from 'electron';

/** 从 Electron autoUpdater 归一化出来的事件。`update-available` 不是终态 ——
 *  它之后会自动开始下载，终态是 downloaded / not-available / error 三者之一。 */
export type UpdaterEvent =
  | { type: 'update-available' }
  | { type: 'update-not-available' }
  | { type: 'update-downloaded'; releaseName: string }
  | { type: 'error'; message: string };

/** 把 autoUpdater 抽成可注入的接口，Windows 控制逻辑才能在 node 环境下单测。 */
export interface UpdaterPort {
  setFeedURL(url: string, headers: Record<string, string>): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  on(listener: (e: UpdaterEvent) => void): void;
}

export function createElectronUpdaterPort(): UpdaterPort {
  const listeners: Array<(e: UpdaterEvent) => void> = [];
  const emit = (e: UpdaterEvent) => { for (const l of listeners) l(e); };

  autoUpdater.on('update-available', () => emit({ type: 'update-available' }));
  autoUpdater.on('update-not-available', () => emit({ type: 'update-not-available' }));
  // Squirrel.Windows 只提供 releaseName（updateURL 在 Windows 不可用），
  // 因此这里只取它，且仅作展示 label 用，不当身份标识。
  autoUpdater.on('update-downloaded', (_e, _notes, releaseName) =>
    emit({ type: 'update-downloaded', releaseName: String(releaseName ?? '') }));
  autoUpdater.on('error', (err) => emit({ type: 'error', message: String(err?.message ?? err) }));

  return {
    setFeedURL: (url, headers) => autoUpdater.setFeedURL({ url, headers }),
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    on: (l) => { listeners.push(l); },
  };
}
