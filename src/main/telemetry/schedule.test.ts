// src/main/telemetry/schedule.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { createSchedule } from './schedule';
import { FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS } from './constants';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kydog-sched-'));
  vi.spyOn(paths, 'LAST_BEACON_FILE', 'get').mockReturnValue(path.join(dir, 'last-beacon'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const lastBeaconPath = () => path.join(dir, 'last-beacon');

function make(send: () => Promise<{ kind: 'sent' } | { kind: 'failed'; reason: string }>) {
  return createSchedule({ send, now: () => new Date('2026-08-05T10:00:00Z') });
}

describe('createSchedule.checkOnce', () => {
  it('last-beacon 不存在时发送，并写入今日 UTC 日期', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' });
    await make(send).checkOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect(readFileSync(lastBeaconPath(), 'utf8')).toBe('2026-08-05');
  });

  it('同一 UTC 日内第二次检查不发送', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' });
    const s = make(send);
    await s.checkOnce();
    await s.checkOnce();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('跨日后再次发送', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' });
    writeFileSync(lastBeaconPath(), '2026-08-04');
    await make(send).checkOnce();
    expect(send).toHaveBeenCalledTimes(1);
    expect(readFileSync(lastBeaconPath(), 'utf8')).toBe('2026-08-05');
  });

  it('发送失败时不写日期 —— 下次检查会重试', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'failed', reason: 'offline' });
    await make(send).checkOnce();
    expect(existsSync(lastBeaconPath())).toBe(false);
  });

  it('last-beacon 内容损坏时视为需发送', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' });
    writeFileSync(lastBeaconPath(), 'not-a-date');
    await make(send).checkOnce();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('未来日期（时钟回拨）也视为需发送 —— 服务端主键兜住重复', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' });
    writeFileSync(lastBeaconPath(), '2099-01-01');
    await make(send).checkOnce();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('createSchedule.stop', () => {
  it('等待在途请求结束后才 resolve', async () => {
    let release!: () => void;
    const inflight = new Promise<void>((r) => { release = r; });
    let settled = false;
    const send = vi.fn().mockImplementation(async () => {
      await inflight;
      settled = true;
      return { kind: 'sent' as const };
    });
    const s = make(send);
    const running = s.checkOnce();
    const stopping = s.stop();
    release();
    await stopping;
    expect(settled).toBe(true);
    await running;
  });

  it('日期写入失败时不 reject，stop 仍正常 resolve', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' });
    vi.spyOn(paths, 'LAST_BEACON_FILE', 'get').mockReturnValue('/nonexistent-dir/last-beacon');
    const s = make(send);
    await expect(s.checkOnce()).resolves.toBeUndefined();
    await expect(s.stop()).resolves.toBeUndefined();
  });

  it('stop 之后 checkOnce 不再发送', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' });
    const s = make(send);
    await s.stop();
    await s.checkOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it('两次并发 checkOnce 都被 stop() 等到', async () => {
    // A 先起、后完成；B 后起、先完成 —— 单槽 inflight 实现下，B 完成时会把
    // inflight 清空成 null，stop() 到这里就误以为「没有在途请求」提前 resolve，
    // 完全不管仍在等 gateA 的 A。
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    let settledA = false;
    const send = vi.fn()
      .mockImplementationOnce(async () => { await gateA; settledA = true; return { kind: 'sent' as const }; })
      .mockImplementationOnce(async () => ({ kind: 'sent' as const }));
    const s = make(send);
    const runningA = s.checkOnce();
    const runningB = s.checkOnce();
    await runningB; // B 先落地

    let stopSettled = false;
    const stopping = s.stop().then(() => { stopSettled = true; });
    // 多轮微任务但不放行 A：修复前 stop() 在这里就已经 resolve 了
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(settledA).toBe(false);

    releaseA();
    await stopping;
    expect(settledA).toBe(true);
    await runningA;
  });
});

describe('createSchedule.start（fake timers）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('FIRST_CHECK_DELAY_MS 后触发首检，此后每 CHECK_INTERVAL_MS 触发一次', async () => {
    let day = '2026-08-05';
    const send = vi.fn().mockResolvedValue({ kind: 'sent' });
    const s = createSchedule({ send, now: () => new Date(`${day}T10:00:00Z`) });
    s.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(send).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(1);
    day = '2026-08-06'; // 跨日：否则同一天会被去重挡住，测不出 interval 有没有真的触发
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stop() 之后推进时间不再有任何 send', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' });
    const s = createSchedule({ send, now: () => new Date('2026-08-05T10:00:00Z') });
    s.start();
    await s.stop();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS * 3);
    expect(send).not.toHaveBeenCalled();
  });

  it('重复 start() 不泄漏 timer —— 不会形成两组定时器重复触发', async () => {
    // send 卡在一个不会自动落地的 gate 上：如果真的排出了两组 timer，
    // 两组各自的 firstTimer 到期时都会在对方写完日期去重之前发起调用，
    // 立刻体现为 2 次；用会立即 resolve 的 send 则会被去重逻辑掩盖掉。
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const send = vi.fn().mockImplementation(async () => { await gate; return { kind: 'sent' as const }; });
    const s = createSchedule({ send, now: () => new Date('2026-08-05T10:00:00Z') });
    s.start();
    s.start(); // 重复调用：修复前会在旧的一组之外再排一组，两组各自空转
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
  });
});
