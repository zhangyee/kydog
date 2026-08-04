import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler } from './scheduler';

describe('update scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('开启后 30 秒首检，随后每 24 小时一次', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const s = createScheduler({ run, firstDelayMs: 30_000, intervalMs: 86_400_000 });
    s.reconfigure(true);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(run).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('关闭后不再发起任何检查', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const s = createScheduler({ run, firstDelayMs: 30_000, intervalMs: 86_400_000 });
    s.reconfigure(true);
    await vi.advanceTimersByTimeAsync(10_000);
    s.reconfigure(false);
    await vi.advanceTimersByTimeAsync(86_400_000 * 2);
    expect(run).toHaveBeenCalledTimes(0);
  });

  it('从关到开会重新安排首检', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const s = createScheduler({ run, firstDelayMs: 30_000, intervalMs: 86_400_000 });
    s.reconfigure(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(0);
    s.reconfigure(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop 之后不再触发', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const s = createScheduler({ run, firstDelayMs: 30_000, intervalMs: 86_400_000 });
    s.reconfigure(true);
    s.stop();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledTimes(0);
  });
});
