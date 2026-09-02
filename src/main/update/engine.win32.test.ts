import { describe, it, expect, vi } from 'vitest';
import { createWin32Engine, type CheckOutcome } from './engine';
import type { UpdaterPort, UpdaterEvent } from './updaterPort';

function fakePort() {
  const listeners: Array<(e: UpdaterEvent) => void> = [];
  const port: UpdaterPort & { emit(e: UpdaterEvent): void; checks: number } = {
    checks: 0,
    setFeedURL: vi.fn(),
    checkForUpdates() { port.checks += 1; },
    quitAndInstall: vi.fn(),
    on(l) { listeners.push(l); },
    emit(e) { for (const l of listeners) l(e); },
  };
  return port;
}

describe('win32 CheckEngine', () => {
  it('update-not-available → none，且调用了底层检查', async () => {
    const port = fakePort();
    const e = createWin32Engine({ port, feedUrl: 'u', userAgent: 'ua', deadlineMs: 1000 });
    const p = e.run(new AbortController().signal);
    port.emit({ type: 'update-not-available' });
    expect(await p).toEqual({ kind: 'none' });
    expect(port.checks).toBe(1);
  });

  it('update-downloaded → downloaded，label 取 releaseName', async () => {
    const port = fakePort();
    const e = createWin32Engine({ port, feedUrl: 'u', userAgent: 'ua', deadlineMs: 1000 });
    const p = e.run(new AbortController().signal);
    port.emit({ type: 'update-downloaded', releaseName: 'KyDog 0.2.0' });
    expect(await p).toEqual({ kind: 'downloaded', label: 'KyDog 0.2.0' });
  });

  it('error → failed 且 retry 为 allowed（正常收到的错误可以再试）', async () => {
    const port = fakePort();
    const e = createWin32Engine({ port, feedUrl: 'u', userAgent: 'ua', deadlineMs: 1000 });
    const p = e.run(new AbortController().signal);
    port.emit({ type: 'error', message: 'boom' });
    const r = await p;
    expect(r).toMatchObject({ kind: 'failed', retry: 'allowed' });
  });

  // update-available 之后 Squirrel 会自动下整包（v0.2.0 的 nupkg 182MB），耗时按带宽算
  // 分钟起步，必然越过 deadline。此前这里把它当非终态，于是 30 秒后本次检查被判成
  // 「检查更时超时；本次运行期间已停止检查，请重启应用」——而下载正在正常进行，两分钟后
  // 迟到的 downloaded 又把横幅弹出来。用户看到的那条失败提示是假的。
  // 现在 update-available 就是本次检查的终态：它是协议事实（下载已开始），如实说出来。
  it('update-available → downloading，立即兑现，不拖到 deadline', async () => {
    const port = fakePort();
    const e = createWin32Engine({ port, feedUrl: 'u', userAgent: 'ua', deadlineMs: 1000 });
    const p = e.run(new AbortController().signal);
    port.emit({ type: 'update-available' });
    expect(await p).toEqual({ kind: 'downloading' });
  });

  it('downloading 之后越过 deadline 也不再产出失败；downloaded 走迟到通道', async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const e = createWin32Engine({ port, feedUrl: 'u', userAgent: 'ua', deadlineMs: 1000 });
    const late: CheckOutcome[] = [];
    e.onLateOutcome((o) => late.push(o));
    const p = e.run(new AbortController().signal);
    port.emit({ type: 'update-available' });
    expect(await p).toEqual({ kind: 'downloading' });
    await vi.advanceTimersByTimeAsync(5_000);       // 早已越过 deadline
    expect(late).toEqual([]);                        // 关键：不许冒出 failed
    port.emit({ type: 'update-downloaded', releaseName: 'KyDog 0.2.0' });
    expect(late).toEqual([{ kind: 'downloaded', label: 'KyDog 0.2.0' }]);
    vi.useRealTimers();
  });

  it('deadline 到达且无终态事件 → failed + restart-required', async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const e = createWin32Engine({ port, feedUrl: 'u', userAgent: 'ua', deadlineMs: 1000 });
    const p = e.run(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ kind: 'failed', retry: 'restart-required' });
    vi.useRealTimers();
  });

  it('deadline 之后到达的终态事件经 onLateOutcome 送出', async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const e = createWin32Engine({ port, feedUrl: 'u', userAgent: 'ua', deadlineMs: 1000 });
    const late: unknown[] = [];
    e.onLateOutcome((o) => late.push(o));
    const p = e.run(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    port.emit({ type: 'update-not-available' });
    port.emit({ type: 'update-downloaded', releaseName: 'v2' });
    expect(late).toEqual([{ kind: 'none' }, { kind: 'downloaded', label: 'v2' }]);
    vi.useRealTimers();
  });

  // 慢网络下 deadline 可能先于 update-available 到达：本次检查已被判成
  // 「超时，本次运行停止检查」，随后下载才开始。这条迟到的 downloading 是解锁的证据 ——
  // 丢掉它，用户就要盯着一条假失败等到下载完成为止。
  it('迟到的 update-available → downloading，用来解除 deadline 造成的禁用', async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const e = createWin32Engine({ port, feedUrl: 'u', userAgent: 'ua', deadlineMs: 1000 });
    const late: unknown[] = [];
    e.onLateOutcome((o) => late.push(o));
    const p = e.run(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    port.emit({ type: 'update-available' });
    expect(late).toEqual([{ kind: 'downloading' }]);
    vi.useRealTimers();
  });
});
