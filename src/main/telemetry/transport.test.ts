import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendBeacon, forget } from './transport';
import { REQUEST_TIMEOUT_MS } from './constants';

const payload = { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', platform: 'darwin', arch: 'arm64', version: '0.3.1' } as const;
const res = (status: number) => new Response(null, { status });

afterEach(() => {
  vi.useRealTimers();
});

describe('sendBeacon', () => {
  it('204 记为 sent', async () => {
    const f = vi.fn().mockResolvedValue(res(204));
    await expect(sendBeacon(payload, f)).resolves.toEqual({ kind: 'sent' });
  });

  it('默认 POST 到生产端点，body 是完整 payload', async () => {
    const f = vi.fn().mockResolvedValue(res(204));
    await sendBeacon(payload, f);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://kydog-analytics.yeezhang.im/v1/beacon');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it('503 记为 failed', async () => {
    const f = vi.fn().mockResolvedValue(res(503));
    const r = await sendBeacon(payload, f);
    expect(r.kind).toBe('failed');
  });

  it('任何非 204 都是 failed，200 也不例外', async () => {
    const f = vi.fn().mockResolvedValue(res(200));
    expect((await sendBeacon(payload, f)).kind).toBe('failed');
  });

  it('网络异常不抛出，转成 failed', async () => {
    const f = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await sendBeacon(payload, f);
    expect(r.kind).toBe('failed');
    expect((r as { reason: string }).reason).toContain('ECONNREFUSED');
  });

  // 若有人把 signal 从 fetch init 里删掉或传错，这条用例应当变红——
  // doFetch 只在 signal 被 abort 时才 reject，永不自己 resolve/reject。
  it('超时后走 abort，记为 failed', async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockImplementation((_url: string, init: Parameters<typeof fetch>[1]) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = sendBeacon(payload, f);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    const r = await pending;
    expect(r.kind).toBe('failed');
  });
});

describe('forget', () => {
  it('204 记为 confirmed', async () => {
    const f = vi.fn().mockResolvedValue(res(204));
    await expect(forget(payload.id, f)).resolves.toEqual({ kind: 'confirmed' });
  });

  it('503 记为 failed —— 客户端据此保留本地 ID', async () => {
    const f = vi.fn().mockResolvedValue(res(503));
    expect((await forget(payload.id, f)).kind).toBe('failed');
  });

  it('网络异常不抛出', async () => {
    const f = vi.fn().mockRejectedValue(new Error('offline'));
    expect((await forget(payload.id, f)).kind).toBe('failed');
  });
});
