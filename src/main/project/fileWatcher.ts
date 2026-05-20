import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';

const DEBOUNCE_MS = 200;

export class FileWatcherService {
  private watchers = new Map<string, FSWatcher>();
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private emit: (projectPath: string) => void;

  constructor(opts?: { debounceMs?: number; emit?: (projectPath: string) => void }) {
    this.debounceMs = opts?.debounceMs ?? DEBOUNCE_MS;
    this.emit = opts?.emit ?? ((projectPath) => broadcaster.emit('fs.changed', { projectPath }));
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
    watcher
      .on('add', onEvent)
      .on('addDir', onEvent)
      .on('unlink', onEvent)
      .on('unlinkDir', onEvent)
      .on('error', (err) => logger.warn('fileWatcher', 'watcher error', { projectPath, err: String(err) }));
    this.watchers.set(projectPath, watcher);
  }

  async stop(projectPath: string): Promise<void> {
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

  private scheduleEmit(projectPath: string): void {
    const existing = this.pendingTimers.get(projectPath);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.pendingTimers.delete(projectPath);
      this.emit(projectPath);
    }, this.debounceMs);
    this.pendingTimers.set(projectPath, t);
  }
}

export const fileWatcherService = new FileWatcherService();
