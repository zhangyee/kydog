import path from 'node:path';
import { watch as fsWatch } from 'node:fs';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';
import { isListedName } from './listing';

const DEBOUNCE_MS = 200;

/** 一个窗口此刻在看的东西：列表缓存着的目录，与跟着磁盘走的已打开文件。 */
export type WatchSet = { dirs: string[]; files: string[] };

type Handle = { close(): void };
export type WatchFn = (
  dir: string,
  onEvent: (eventType: string, filename: string | null) => void,
  onError: (err: Error) => void,
) => Handle;

const nodeWatch: WatchFn = (dir, onEvent, onError) => {
  const w = fsWatch(dir, { persistent: true }, (eventType, filename) => onEvent(eventType, filename));
  w.on('error', onError);
  return w;
};

/**
 * 只盯渲染层此刻在看的东西，一个目录一个 `fs.watch` 句柄，不递归。
 *
 * **为什么不再整树监听**：以前启动时给每个已打开的 project 挂一个 chokidar，整棵树递归。
 * chokidar 对每个文件都要 stat 一次、再单独开一个 `fs.watch`，成本跟文件数成正比，而且
 * 与用户看不看那个 project 无关。用户侧栏里有一个装了大量数据文件的 project（从没点开过），
 * 启动后的扫描把主进程 libuv 的 4 个线程占满，此后每一个异步 fs 调用都在排队：
 * 新对话永远停在「加载中」（`loadHistory` 第一步就要读 index），检视栏的文件树同样。
 *
 * 所以监听集合**由渲染层声明**（`fs.setWatched`，整份替换）：列表缓存着的目录 + 跟着
 * 磁盘走的已打开文件。成本跟屏幕上的东西成正比，跟 project 多大无关。按窗口分账，
 * 窗口没了就把它那份撤掉（`forget`），取并集后逐目录开/关句柄。
 *
 * 两条出口，语义与以前相同：
 *  · `fs.changed { dir }` —— 这个目录的列表变了（有条目出现、消失或改名），重读它；
 *  · `file.changed { path }` —— 这个文件被动过（改写或原子替换），带的是渲染层声明时的那串路径。
 */
export class FileWatcherService {
  private bySender = new Map<number, WatchSet>();
  private dirs = new Set<string>();
  private files = new Set<string>();
  private handles = new Map<string, Handle>();
  private dirTimers = new Map<string, NodeJS.Timeout>();
  private fileTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private emitDir: (dir: string) => void;
  private emitFile: (filePath: string) => void;
  private watch: WatchFn;

  constructor(opts?: {
    debounceMs?: number;
    emitDir?: (dir: string) => void;
    emitFile?: (filePath: string) => void;
    watch?: WatchFn;
  }) {
    this.debounceMs = opts?.debounceMs ?? DEBOUNCE_MS;
    this.emitDir = opts?.emitDir ?? ((dir) => broadcaster.emit('fs.changed', { dir }));
    this.emitFile = opts?.emitFile ?? ((filePath) => broadcaster.emit('file.changed', { path: filePath }));
    this.watch = opts?.watch ?? nodeWatch;
  }

  /** 整份替换这个窗口的监听集合。句柄在这里同步开，不等任何 await —— 渲染层先声明、
   *  再读目录，两条 IPC 按序到达，所以句柄总是先于那次读目录开起来。 */
  set(senderId: number, want: WatchSet): void {
    this.bySender.set(senderId, { dirs: [...want.dirs], files: [...want.files] });
    this.reconcile();
  }

  /** 窗口没了：撤掉它那一份。 */
  forget(senderId: number): void {
    if (this.bySender.delete(senderId)) this.reconcile();
  }

  stopAll(): void {
    this.bySender.clear();
    this.reconcile();
  }

  /** 此刻开着句柄的目录。 */
  watchedDirs(): string[] {
    return [...this.handles.keys()].sort();
  }

  private reconcile(): void {
    const dirs = new Set<string>();
    const files = new Set<string>();
    for (const s of this.bySender.values()) {
      for (const d of s.dirs) dirs.add(d);
      for (const f of s.files) files.add(f);
    }
    this.dirs = dirs;
    this.files = files;

    // 文件没有自己的句柄：盯它所在的目录，按文件名认。
    const needed = new Set<string>(dirs);
    for (const f of files) needed.add(path.dirname(f));
    for (const [dir, h] of this.handles) {
      if (!needed.has(dir)) { h.close(); this.handles.delete(dir); }
    }
    for (const dir of needed) {
      if (!this.handles.has(dir)) this.open(dir);
    }

    // 撤掉的那些，还挂着的定时器一起清：不清的话撤掉之后还会冒出一条事件。
    for (const [d, t] of this.dirTimers) {
      if (!dirs.has(d)) { clearTimeout(t); this.dirTimers.delete(d); }
    }
    for (const [f, t] of this.fileTimers) {
      if (!files.has(f)) { clearTimeout(t); this.fileTimers.delete(f); }
    }
  }

  private open(dir: string): void {
    try {
      this.handles.set(dir, this.watch(
        dir,
        (eventType, filename) => this.onEvent(dir, eventType, filename),
        (err) => this.onError(dir, err),
      ));
    } catch (err) {
      // 目录不在了 / 没权限：装不上就不装。渲染层读这个目录时会自己拿到那个错误。
      logger.warn('fileWatcher', 'watch failed', { dir, err: String(err) });
    }
  }

  private onEvent(dir: string, eventType: string, filename: string | null): void {
    if (filename === null) {
      // 平台没给文件名：说不出是谁变了，那就是谁都可能变了。
      if (this.dirs.has(dir)) this.schedule(this.dirTimers, dir, this.emitDir);
      for (const f of this.files) {
        if (path.dirname(f) === dir) this.schedule(this.fileTimers, f, this.emitFile);
      }
      return;
    }
    // 列表只关心条目的增、删、改名 —— 那些都是 rename；内容改动（change）不动列表。
    if (eventType === 'rename' && this.dirs.has(dir) && isListedName(filename)) {
      this.schedule(this.dirTimers, dir, this.emitDir);
    }
    for (const f of this.files) {
      if (path.dirname(f) === dir && path.basename(f) === filename) {
        this.schedule(this.fileTimers, f, this.emitFile);
      }
    }
  }

  private onError(dir: string, err: Error): void {
    // 常见于目录本身被删：句柄已经废了，关掉。让渲染层重读一次，它会拿到真实的错误并撤掉这个目录。
    logger.warn('fileWatcher', 'watcher error', { dir, err: String(err) });
    this.handles.get(dir)?.close();
    this.handles.delete(dir);
    if (this.dirs.has(dir)) this.schedule(this.dirTimers, dir, this.emitDir);
  }

  private schedule(timers: Map<string, NodeJS.Timeout>, key: string, emit: (key: string) => void): void {
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      emit(key);
    }, this.debounceMs));
  }
}

export const fileWatcherService = new FileWatcherService();
