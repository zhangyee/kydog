import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { FileWatcherService } from './fileWatcher';

async function mkTmp(prefix: string): Promise<string> {
  const base = path.join(os.tmpdir(), `kydog-fw-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(base, { recursive: true });
  return base;
}

describe('FileWatcherService', () => {
  let tmp: string;

  beforeEach(async () => { tmp = await mkTmp('root'); });
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); });

  it('debounces multiple changes into one emit per project', async () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const svc = new FileWatcherService({ debounceMs: 50, emit });
    svc.triggerForTest(tmp);
    svc.triggerForTest(tmp);
    svc.triggerForTest(tmp);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(tmp);
    vi.useRealTimers();
  });

  it('start/stop is idempotent and isWatching reflects state', async () => {
    const svc = new FileWatcherService({ emit: () => {} });
    expect(svc.isWatching(tmp)).toBe(false);
    svc.start(tmp);
    expect(svc.isWatching(tmp)).toBe(true);
    svc.start(tmp); // re-start is no-op
    expect(svc.isWatching(tmp)).toBe(true);
    await svc.stop(tmp);
    expect(svc.isWatching(tmp)).toBe(false);
    await svc.stop(tmp); // re-stop is no-op
  });

  it('emits fs.changed when a file is created under the watched root', async () => {
    const emit = vi.fn();
    // add 现在也会触发文件级通路；不传 emitFile 就会落到真实 broadcaster（依赖
    // Electron BrowserWindow），测试环境里没有，得显式给个空实现挡住。
    const svc = new FileWatcherService({ debounceMs: 50, emit, emitFile: () => {} });
    svc.start(tmp);
    // chokidar needs a moment to attach watchers before initial scan finishes
    await new Promise((r) => setTimeout(r, 200));
    await fs.writeFile(path.join(tmp, 'report.md'), '# hi');
    // wait through awaitWriteFinish (200ms) + debounce (50ms) + margin
    await new Promise((r) => setTimeout(r, 700));
    expect(emit).toHaveBeenCalledWith(tmp);
    await svc.stop(tmp);
  });

  it('stopAll clears all watchers', async () => {
    const svc = new FileWatcherService({ emit: () => {} });
    const other = await mkTmp('other');
    try {
      svc.start(tmp);
      svc.start(other);
      expect(svc.isWatching(tmp) && svc.isWatching(other)).toBe(true);
      await svc.stopAll();
      expect(svc.isWatching(tmp) || svc.isWatching(other)).toBe(false);
    } finally {
      await fs.rm(other, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('同一路径的多次改动 debounce 成一次 file.changed', async () => {
    vi.useFakeTimers();
    const emitFile = vi.fn();
    const svc = new FileWatcherService({ debounceMs: 50, emit: () => {}, emitFile });
    const f = path.join(tmp, 'a.html');
    svc.triggerFileForTest(f);
    svc.triggerFileForTest(f);
    expect(emitFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(emitFile).toHaveBeenCalledTimes(1);
    expect(emitFile).toHaveBeenCalledWith(f);
    vi.useRealTimers();
  });

  it('不同路径互不吞没', async () => {
    vi.useFakeTimers();
    const emitFile = vi.fn();
    const svc = new FileWatcherService({ debounceMs: 50, emit: () => {}, emitFile });
    const a = path.join(tmp, 'a.html');
    const b = path.join(tmp, 'b.html');
    svc.triggerFileForTest(a);
    svc.triggerFileForTest(b);
    await vi.advanceTimersByTimeAsync(60);
    expect(emitFile.mock.calls.map((c) => c[0]).sort()).toEqual([a, b].sort());
    vi.useRealTimers();
  });

  it('内容改动触发 file.changed 且带正确路径', async () => {
    const f = path.join(tmp, 'a.html');
    await fs.writeFile(f, '<h1>v1</h1>');
    const seen: string[] = [];
    const svc = new FileWatcherService({ debounceMs: 20, emit: () => {}, emitFile: (p) => seen.push(p) });
    svc.start(tmp);
    await new Promise((r) => setTimeout(r, 300)); // 等 chokidar ready
    await fs.writeFile(f, '<h1>v2</h1>');
    await new Promise((r) => setTimeout(r, 800)); // awaitWriteFinish 200ms + debounce
    await svc.stop(tmp);
    expect(seen).toContain(f);
  });

  it('stop 之后不再发 file.changed', async () => {
    vi.useFakeTimers();
    const emitFile = vi.fn();
    const svc = new FileWatcherService({ debounceMs: 50, emit: () => {}, emitFile });
    svc.triggerFileForTest(path.join(tmp, 'a.html'));
    await svc.stop(tmp);
    await vi.advanceTimersByTimeAsync(60);
    expect(emitFile).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
