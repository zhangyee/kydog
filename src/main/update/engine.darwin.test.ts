import { describe, it, expect, vi } from 'vitest';
import { createDarwinEngine } from './engine';

function engineWith(fetchImpl: typeof fetch) {
  return createDarwinEngine({ feedUrl: 'https://feed.test/x', userAgent: 'KyDog/0.1.0', fetchFn: fetchImpl });
}

describe('darwin CheckEngine', () => {
  it('204 → none', async () => {
    const e = engineWith(vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as never);
    expect(await e.run(new AbortController().signal)).toEqual({ kind: 'none' });
  });

  it('200 → available，label 取 name、candidateId 取 url', async () => {
    const body = JSON.stringify({ name: 'KyDog 0.2.0', notes: 'x', url: 'https://gh/x-darwin-arm64-0.2.0.zip' });
    const e = engineWith(vi.fn().mockResolvedValue(new Response(body, { status: 200 })) as never);
    expect(await e.run(new AbortController().signal)).toEqual({
      kind: 'available',
      label: 'KyDog 0.2.0',
      candidateId: 'https://gh/x-darwin-arm64-0.2.0.zip',
    });
  });

  it('404 是发布配置问题，不能说成「已是最新」', async () => {
    const e = engineWith(vi.fn().mockResolvedValue(new Response('no assets', { status: 404 })) as never);
    const r = await e.run(new AbortController().signal);
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') {
      expect(r.retry).toBe('allowed');
      expect(r.message).toContain('发布配置');
    }
  });

  it('其他 4xx / 5xx → failed', async () => {
    const e = engineWith(vi.fn().mockResolvedValue(new Response('rate limited', { status: 403 })) as never);
    const r = await e.run(new AbortController().signal);
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.retry).toBe('allowed');
  });

  it('网络异常 → failed，不抛出', async () => {
    const e = engineWith(vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as never);
    const r = await e.run(new AbortController().signal);
    expect(r.kind).toBe('failed');
  });

  it('JSON 形状不符 → failed，不当成 available', async () => {
    const e = engineWith(vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: 1, url: null }), { status: 200 })) as never);
    const r = await e.run(new AbortController().signal);
    expect(r.kind).toBe('failed');
  });

  it('把 signal 透传给 fetch，deadline 才能真正中止请求', async () => {
    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const e = engineWith(spy as never);
    const ac = new AbortController();
    await e.run(ac.signal);
    expect(spy.mock.calls[0][1]).toMatchObject({ signal: ac.signal });
  });
});
