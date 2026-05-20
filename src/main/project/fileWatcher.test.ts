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
    const svc = new FileWatcherService({ debounceMs: 50, emit });
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
});
