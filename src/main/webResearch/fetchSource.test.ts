import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { fetch as undiciFetch } from 'undici';
import { ResearchBudgetMeter, DEFAULT_RESEARCH_BUDGET } from './budget';
import { createResearchDispatcher, fetchSource } from './fetchSource';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 as const }];
const budget = () => new ResearchBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET, maxBytesPerSource: 1000,
  maxTotalBytes: 1500, maxRedirectsPerSource: 3 });
const deps = (client: (url: string, init: { redirect: string; route: { kind: string } }) => Promise<Response>) => ({
  resolveProxy: async (_url: string) => 'DIRECT', resolveDns: publicDns, httpClient: client,
});

describe('fetchSource', () => {
  it('逐跳处理相对与跨站 HTTP Location，保留最终 URL 和路由事实', async () => {
    const calls: Array<{ url: string; kind: string; redirect: string }> = [];
    const client = vi.fn(async (url: string, init: { redirect: string; route: { kind: string } }) => {
      calls.push({ url, kind: init.route.kind, redirect: init.redirect });
      if (url.endsWith('/start')) return new Response(null, { status: 302, headers: { location: '/next' } });
      if (url.endsWith('/next')) return new Response(null, { status: 301, headers: { location: 'https://other.example/end' } });
      return new Response('Page body', { headers: { 'content-type': 'text/plain' } });
    });
    const result = await fetchSource({ url: 'https://docs.example/start', budget: budget(), signal: new AbortController().signal }, deps(client));
    expect(result.status).toBe('readable');
    expect(result.finalUrl).toBe('https://other.example/end');
    expect(result.redirectChain).toEqual([
      { fromUrl: 'https://docs.example/start', toUrl: 'https://docs.example/next', kind: 'http', statusCode: 302 },
      { fromUrl: 'https://docs.example/next', toUrl: 'https://other.example/end', kind: 'http', statusCode: 301 },
    ]);
    expect(calls).toEqual([
      { url: 'https://docs.example/start', kind: 'direct', redirect: 'manual' },
      { url: 'https://docs.example/next', kind: 'direct', redirect: 'manual' },
      { url: 'https://other.example/end', kind: 'direct', redirect: 'manual' },
    ]);
    expect(new TextDecoder().decode(result.bytes)).toBe('Page body');
  });

  it('跨站 Location 指向内网时不派发第二跳', async () => {
    const client = vi.fn(async () => new Response(null, { status: 302,
      headers: { location: 'http://10.1.2.3/admin' } }));
    const result = await fetchSource({ url: 'https://docs.example/start', budget: budget(), signal: new AbortController().signal }, deps(client));
    expect(client).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('network_error');
    expect(result.reason).toBe('unsafe_url');
    expect(result.redirectChain[0].toUrl).toBe('http://10.1.2.3/admin');
  });

  it('循环和缺失 Location 各有明确原因', async () => {
    const looping = await fetchSource({ url: 'https://docs.example/a', budget: budget(), signal: new AbortController().signal },
      deps(async () => new Response(null, { status: 302, headers: { location: '/a' } })));
    expect(looping.status).toBe('redirect_error');
    expect(looping.reason).toBe('redirect_loop');
    const missing = await fetchSource({ url: 'https://docs.example/a', budget: budget(), signal: new AbortController().signal },
      deps(async () => new Response(null, { status: 302 })));
    expect(missing.status).toBe('redirect_error');
    expect(missing.reason).toBe('missing_location');
  });

  it('仅明确 HTML meta refresh 产生跳转，canonical 只是元数据', async () => {
    const client = vi.fn(async (url: string) => url.endsWith('/a')
      ? new Response('<html><head><link rel="canonical" href="https://other.example/canon"><meta http-equiv="refresh" content="0; url=/b"></head></html>',
        { headers: { 'content-type': 'text/html' } })
      : new Response('Target', { headers: { 'content-type': 'text/plain' } }));
    const result = await fetchSource({ url: 'https://docs.example/a', budget: budget(), signal: new AbortController().signal }, deps(client));
    expect(result.finalUrl).toBe('https://docs.example/b');
    expect(result.redirectChain).toEqual([{ fromUrl: 'https://docs.example/a', toUrl: 'https://docs.example/b', kind: 'meta_refresh' }]);
    expect(client).toHaveBeenCalledTimes(2);
  });

  it('按解码后流实际字节在超额点终止，而非信任 Content-Length', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(6)); },
      cancel() { cancelled = true; },
    });
    const meter = new ResearchBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET, maxBytesPerSource: 5 });
    const result = await fetchSource({ url: 'https://docs.example/a', budget: meter, signal: new AbortController().signal },
      deps(async () => new Response(stream, { headers: { 'content-type': 'text/plain', 'content-length': '1' } })));
    expect(result.status).toBe('unreadable');
    expect(result.reason).toBe('source_byte_limit');
    expect(meter.usage.receivedBytes).toBe(0);
    expect(cancelled).toBe(true);
  });

  it('取消后不再派发抓取', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = vi.fn(async () => new Response('should not fetch'));
    const result = await fetchSource({ url: 'https://docs.example/a', budget: budget(), signal: controller.signal }, deps(client));
    expect(result.status).toBe('cancelled');
    expect(client).toHaveBeenCalledTimes(0);
  });

  it('网络异常以固定原因返回，不回显可能包含代理凭据的错误文案', async () => {
    const result = await fetchSource({ url: 'https://docs.example/a', budget: budget(), signal: new AbortController().signal },
      deps(async () => { throw new Error('proxy password: secret'); }));
    expect(result.status).toBe('network_error');
    expect(result.reason).toBe('request_failed');
  });

  it('响应流中途失败时仍记录已接收并占预算的正文净字节', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(3)); },
      pull() { throw new Error('broken stream'); },
    });
    const meter = budget();
    const result = await fetchSource({ url: 'https://docs.example/a', budget: meter, signal: new AbortController().signal },
      deps(async () => new Response(stream, { headers: { 'content-type': 'text/plain' } })));
    expect(result.status).toBe('network_error');
    expect(result.receivedBytes).toBe(3);
    expect(meter.usage.receivedBytes).toBe(3);
  });

  it('真实 undici 派发沿已判定的 HTTP 代理出网', async () => {
    const seen: string[] = [];
    const compressed = gzipSync(Buffer.alloc(300, 'x'));
    const proxy = createServer((request, response) => {
      seen.push(`request:${request.url}`);
      if (request.url?.endsWith('/compressed')) {
        response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip',
          'content-length': compressed.byteLength });
        response.end(compressed);
      } else {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('via-proxy');
      }
    });
    proxy.on('connect', (request, socket) => {
      seen.push(`connect:${request.url}`);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 9\r\n\r\nvia-proxy'));
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as AddressInfo).port;
    try {
      const result = await fetchSource({ url: 'http://docs.example/a', budget: budget(), signal: new AbortController().signal }, {
        resolveProxy: async () => `PROXY 127.0.0.1:${port}`,
        resolveDns: async () => { throw new Error('target DNS must stay at proxy'); },
        proxyEnvironment: {},
      });
      expect(result.status).toBe('readable');
      expect(new TextDecoder().decode(result.bytes)).toBe('via-proxy');
      expect(seen).toEqual(['request:http://docs.example/a']);
      expect(result.assurance).toBe('proxy_dns_unverified');
      const smallBudget = new ResearchBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET, maxBytesPerSource: 200 });
      const decoded = await fetchSource({ url: 'http://docs.example/compressed', budget: smallBudget,
        signal: new AbortController().signal }, {
        resolveProxy: async () => `PROXY 127.0.0.1:${port}`, resolveDns: publicDns, proxyEnvironment: {},
      });
      expect(compressed.byteLength).toBeLessThan(200);
      expect(decoded.status).toBe('unreadable');
      expect(decoded.reason).toBe('source_byte_limit');
      expect(seen).toEqual(['request:http://docs.example/a', 'request:http://docs.example/compressed']);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('DIRECT dispatcher 实际连接预先固定的 IP，同时保留原 URL 的 Host', async () => {
    const hosts: string[] = [];
    const server = createServer((request, response) => {
      hosts.push(request.headers.host ?? '');
      response.end('pinned');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    // The test constructs the post-guard route directly so it can use loopback as
    // a deterministic socket fixture. prepareResearchRoute itself rejects loopback.
    const dispatcher = createResearchDispatcher({ ok: true, kind: 'direct',
      hostname: 'docs.example', address: '127.0.0.1', family: 4, assurance: 'dns_pinned' });
    try {
      const response = await undiciFetch(`http://docs.example:${port}/a`, { dispatcher });
      expect(await response.text()).toBe('pinned');
      expect(hosts).toEqual([`docs.example:${port}`]);
    } finally {
      await dispatcher.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
