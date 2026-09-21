import { useUiStore, followsDisk } from './stores/uiStore';

/**
 * 文件树读目录、以及告诉主进程「这个窗口在看什么」—— 两件事放在一起，因为它们之间有一条
 * 顺序约束：**先声明、再读**。
 *
 * 主进程只盯渲染层声明过的目录与文件（`fs.setWatched`，见 main/project/fileWatcher.ts）。
 * 如果先读目录、拿到列表进了缓存才声明，读完到开始监听之间的变化就没人知道了。所以
 * `loadDir` 先 `beginDirLoad`（store 同步通知订阅者，`installWatchSync` 当场把新的集合发出去），
 * 再 invoke `project.readDir` —— 两条 IPC 按序到达主进程，句柄先于这次读开起来。
 */

export type WatchSet = { dirs: string[]; files: string[] };

/** 这个窗口此刻在看的东西：缓存着列表的目录 + 正在读的目录，跟着磁盘走的已打开文件。 */
export function currentWatchSet(s = useUiStore.getState()): WatchSet {
  const dirs = new Set([...Object.keys(s.dirCache), ...s.dirPending]);
  const files = new Set(s.openFileTabs.filter(followsDisk).map((t) => t.path));
  return { dirs: [...dirs].sort(), files: [...files].sort() };
}

/** 集合一变就整份发给主进程。装上时先发一份（空的也发）：渲染进程重载后，主进程手上
 *  还是上一页声明的那份，得整份替换掉。 */
export function installWatchSync(): () => void {
  let prev: string | null = null;
  const push = () => {
    const next = currentWatchSet();
    const key = JSON.stringify(next);
    if (key === prev) return;
    prev = key;
    void window.kydog.invoke('fs.setWatched', next)
      .catch((err) => console.error('fs.setWatched failed', err));
  };
  push();
  return useUiStore.subscribe(push);
}

/**
 * 读一个目录进文件树缓存。三个入口（project 根、展开的子目录、`fs.changed` 触发的重读）都走这里。
 *
 * 失败必须落进 store：以前这里只有 `.then`，读失败就是一条 unhandled rejection，
 * 文件树永远停在「加载中」，看的人分不出是在读还是已经失败了。
 */
export async function loadDir(dir: string): Promise<void> {
  useUiStore.getState().beginDirLoad(dir);
  // 读的这段时间里目录可能已经不看了（project 从侧栏移除）：那样结果就不该再写回去，
  // 写回去等于把它重新加进监听集合。
  const stillWanted = () => {
    const s = useUiStore.getState();
    return s.dirPending.has(dir) || dir in s.dirCache;
  };
  try {
    const nodes = await window.kydog.invoke('project.readDir', { path: dir });
    if (stillWanted()) useUiStore.getState().setDir(dir, nodes);
  } catch (err) {
    if (stillWanted()) useUiStore.getState().failDir(dir, err instanceof Error ? err.message : String(err));
  }
}
