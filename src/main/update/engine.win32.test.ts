import { describe, it, expect, vi } from 'vitest';
import { createWin32Engine } from './engine';
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

  it('update-available 不是终态，不结束本次检查', async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const e = createWin32Engine({ port, feedUrl: 'u', userAgent: 'ua', deadlineMs: 1000 });
    let settled = false;
    void e.run(new AbortController().signal).then(() => { settled = true; });
    port.emit({ type: 'update-available' });
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
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

  it('迟到的 update-available 不产生 late outcome（它不是终态）', async () => {
    vi.useFakeTimers();
    const port = fakePort();
    const e = createWin32Engine({ port, feedUrl: 'u', userAgent: 'ua', deadlineMs: 1000 });
    const late: unknown[] = [];
    e.onLateOutcome((o) => late.push(o));
    const p = e.run(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    port.emit({ type: 'update-available' });
    expect(late).toEqual([]);
    vi.useRealTimers();
  });
});
