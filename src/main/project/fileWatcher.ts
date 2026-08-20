import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';

const DEBOUNCE_MS = 200;

export class FileWatcherService {
  private watchers = new Map<string, FSWatcher>();
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private pendingFileTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private emit: (projectPath: string) => void;
  private emitFile: (filePath: string) => void;

  constructor(opts?: {
    debounceMs?: number;
    emit?: (projectPath: string) => void;
    emitFile?: (filePath: string) => void;
  }) {
    this.debounceMs = opts?.debounceMs ?? DEBOUNCE_MS;
    this.emit = opts?.emit ?? ((projectPath) => broadcaster.emit('fs.changed', { projectPath }));
    this.emitFile = opts?.emitFile ?? ((filePath) => broadcaster.emit('file.changed', { path: filePath }));
  }

  start(projectPath: string): void {
    if (this.watchers.has(projectPath)) return;
    const watcher = chokidar.watch(projectPath, {
      ignored: (p) => {
        if (p === projectPath) return false;
        const base = path.basename(p);
        if (base.startsWith('.')) return true;
        if (base === 'node_modules') return true;
        return false;
      },
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    const onEvent = () => this.scheduleEmit(projectPath);
    // 内容变更走文件级通路。add 也算：agent 的原子写是「写临时文件 + rename」，
    // 落到 chokidar 上可能是 change 也可能是 add，两条都接才不漏。
    const onFile = (p: string) => this.scheduleFileEmit(p);
    watcher
      .on('add', (p) => { onEvent(); onFile(p); })
      .on('addDir', onEvent)
      .on('change', onFile)
      .on('unlink', onEvent)
      .on('unlinkDir', onEvent)
      .on('error', (err) => logger.warn('fileWatcher', 'watcher error', { projectPath, err: String(err) }));
    this.watchers.set(projectPath, watcher);
  }

  async stop(projectPath: string): Promise<void> {
    // 文件级定时器按文件路径存，不按项目路径存，得按前缀清该项目下所有 pending 的。
    // 放在「没在 watch 就直接返回」之前：stop 是「这个项目不再产出事件」的边界，
    // 不该因为 watcher 对象凑巧不存在（例如只调过 triggerFileForTest）就漏清。
    const prefix = projectPath.endsWith(path.sep) ? projectPath : projectPath + path.sep;
    for (const [p, timer] of this.pendingFileTimers) {
      if (p === projectPath || p.startsWith(prefix)) {
        clearTimeout(timer);
        this.pendingFileTimers.delete(p);
      }
    }
    const w = this.watchers.get(projectPath);
    if (!w) return;
    this.watchers.delete(projectPath);
    const t = this.pendingTimers.get(projectPath);
    if (t) {
      clearTimeout(t);
      this.pendingTimers.delete(projectPath);
    }
    await w.close();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.watchers.keys()].map((p) => this.stop(p)));
  }

  isWatching(projectPath: string): boolean {
    return this.watchers.has(projectPath);
  }

  /** Test hook: invoke debounced emit directly. */
  triggerForTest(projectPath: string): void {
    this.scheduleEmit(projectPath);
  }

  /** Test hook: invoke debounced file-level emit directly. */
  triggerFileForTest(filePath: string): void {
    this.scheduleFileEmit(filePath);
  }

  private scheduleEmit(projectPath: string): void {
    const existing = this.pendingTimers.get(projectPath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.pendingTimers.delete(projectPath);
      this.emit(projectPath);
    }, this.debounceMs);
    this.pendingTimers.set(projectPath, t);
  }

  private scheduleFileEmit(filePath: string): void {
    const existing = this.pendingFileTimers.get(filePath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.pendingFileTimers.delete(filePath);
      this.emitFile(filePath);
    }, this.debounceMs);
    this.pendingFileTimers.set(filePath, t);
  }
}

export const fileWatcherService = new FileWatcherService();
