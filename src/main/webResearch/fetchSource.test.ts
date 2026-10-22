import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { fetch as undiciFetch } from 'undici';
import { ResearchBudgetMeter, DEFAULT_RESEARCH_BUDGET } from './budget';
import { createResearchDispatcher, fetchSiteIcon, fetchSource } from './fetchSource';

const publicDns = async () => [{ address: '93.184.216.34', family: 4 as const }];
const budget = () => new ResearchBudgetMeter({ ...DEFAULT_RESEARCH_BUDGET, maxBytesPerSource: 1000,
  maxTotalBytes: 1500, maxRedirectsPerSource: 3 });
const deps = (client: (url: string, init: { redirect: string; route: { kind: string };
  headers?: Record<string, string> }) => Promise<Response>) => ({
  resolveProxy: async (_url: string) => 'DIRECT', resolveDns: publicDns, httpClient: client,
});

describe('fetchSource', () => {
  it('retains small HTTP diagnostics on 521 while cancelling its body; 200 still reads body bytes', async () => {
    const run = async (status: number, server = 'WAF') => {
      let cancelled = false;
      const bytes = new TextEncoder().encode('challenge or article');
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); },
        pull(controller) { controller.close(); },
        cancel() { cancelled = true; },
      });
      const result = await fetchSource({ url: 'https://blog.csdn.net/author/article', budget: budget(),
        signal: new AbortController().signal }, deps(async () => new Response(stream, {
          status, headers: { 'content-type': 'text/html; charset=utf-8', server, 'set-cookie': 'secret=value' },
        })));
      return { result, cancelled };
    };
    const success = await run(200);
    expect(new TextDecoder().decode(success.result.bytes)).toBe('challenge or article');
    expect(success.result.receivedBytes).toBe(20);
    const error = await run(521);
    expect(error.result).toMatchObject({ status: 'http_error', statusCode: 521,
      contentType: 'text/html; charset=utf-8', server: 'WAF', receivedBytes: 0 });
    expect(error.cancelled).toBe(true);
    expect(error.result.bytes).toHaveLength(0);
    const oversized = await run(521, 'x'.repeat(1000));
    expect(oversized.result.server?.length).toBeLessThanOrEqual(256);
  });

  it('retries one 403 with IAB cookies for that URL and never exposes the cookie in the result', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const client = vi.fn(async (url: string, init: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return calls.length === 1
        ? new Response('forbidden', { status: 403 })
        : new Response('article', { headers: { 'content-type': 'text/plain' } });
    });
    const getBrowserHeaders = vi.fn(async () => ({
      cookie: 'sid=secret', userAgent: 'KyDog IAB', acceptLanguage: 'zh-CN',
    }));
    const result = await fetchSource({ url: 'https://medium.com/article', budget: budget(),
      signal: new AbortController().signal }, { ...deps(client), getMediumBrowserHeaders: getBrowserHeaders });
    expect(result.status).toBe('readable');
    expect(client).toHaveBeenCalledTimes(2);
    expect(calls[0].headers).toBeUndefined();
    expect(calls[1].headers).toMatchObject({ cookie: 'sid=secret',
      'user-agent': 'KyDog IAB', 'accept-language': 'zh-CN' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('drops Medium IAB cookies after a cross-site redirect', async () => {
    const calls: Array<{ url: string; cookie?: string }> = [];
    const client = vi.fn(async (url: string, init: { headers?: Record<string, string> }) => {
      calls.push({ url, cookie: init.headers?.cookie });
      if (url === 'https://medium.com/start' && calls.length === 1) return new Response(null, { status: 403 });
      if (url === 'https://medium.com/start') return new Response(null, { status: 302,
        headers: { location: 'https://other.example/final' } });
      return new Response('target', { headers: { 'content-type': 'text/plain' } });
    });
    const getBrowserHeaders = vi.fn(async () => ({ cookie: 'medium=one' }));
    const result = await fetchSource({ url: 'https://medium.com/start', budget: budget(),
      signal: new AbortController().signal }, { ...deps(client), getMediumBrowserHeaders: getBrowserHeaders });
    expect(result.status).toBe('readable');
    expect(calls).toEqual([
      { url: 'https://medium.com/start', cookie: undefined },
      { url: 'https://medium.com/start', cookie: 'medium=one' },
      { url: 'https://other.example/final', cookie: undefined },
    ]);
    expect(getBrowserHeaders).toHaveBeenCalledWith('https://medium.com/start');
    expect(getBrowserHeaders).toHaveBeenCalledTimes(1);
  });

  it('marks a source needs_browser when one cookie-assisted retry remains forbidden', async () => {
    const client = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const result = await fetchSource({ url: 'https://medium.com/article', budget: budget(),
      signal: new AbortController().signal }, {
      ...deps(client), getMediumBrowserHeaders: async () => ({ cookie: 'sid=secret' }),
    });
    expect(client).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'needs_browser', reason: 'HTTP 403 after IAB cookie retry',
      statusCode: 403 });
  });

  it('never reads IAB cookies for a non-Medium 403', async () => {
    const getMediumBrowserHeaders = vi.fn(async () => ({ cookie: 'must-not-send=secret' }));
    const client = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const result = await fetchSource({ url: 'https://other.example/article', budget: budget(),
      signal: new AbortController().signal }, {
      ...deps(client), getMediumBrowserHeaders,
    });
    expect(client).toHaveBeenCalledTimes(1);
    expect(getMediumBrowserHeaders).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'http_error', reason: 'HTTP 403', statusCode: 403 });
  });

  it('fetches a small declared image through the guarded route and returns a data URL', async () => {
    const icon = Uint8Array.from([137, 80, 78, 71]);
    const client = vi.fn(async () => new Response(icon, { headers: { 'content-type': 'image/png' } }));
    await expect(fetchSiteIcon('https://docs.example/icon.png', new AbortController().signal,
      deps(client))).resolves.toBe('data:image/png;base64,iVBORw==');
    expect(client).toHaveBeenCalledTimes(1);
  });

  it('rejects non-image and oversized favicon responses', async () => {
    const text = await fetchSiteIcon('https://docs.example/icon', new AbortController().signal,
      deps(async () => new Response('not an icon', { headers: { 'content-type': 'text/plain' } })));
    expect(text).toBeUndefined();
    const huge = await fetchSiteIcon('https://docs.example/icon.png', new AbortController().signal,
      deps(async () => new Response(new Uint8Array(33 * 1024), { headers: { 'content-type': 'image/png' } })));
    expect(huge).toBeUndefined();
  });

  it('closes a PDF response before reading its body', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024)); },
      cancel() { cancelled = true; },
    });
    const meter = budget();
    const result = await fetchSource({ url: 'https://docs.example/opaque', budget: meter,
      signal: new AbortController().signal }, deps(async () => new Response(stream, {
        headers: { 'content-type': 'application/pdf' },
      })));
    expect(result.status).toBe('unsupported_media');
    expect(result.reason).toBe('pdf_not_supported');
    expect(result.bytes).toHaveLength(0);
    expect(meter.usage.receivedBytes).toBe(0);
    expect(cancelled).toBe(true);
  });

  it('stops a PDF stream mislabeled as HTML after its signature', async () => {
    let cancelled = false;
    const signature = new TextEncoder().encode('%PDF-');
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(first ? signature : new Uint8Array(512));
        first = false;
      },
      cancel() { cancelled = true; },
    });
    const meter = budget();
    const result = await fetchSource({ url: 'https://docs.example/opaque', budget: meter,
      signal: new AbortController().signal }, deps(async () => new Response(stream, {
        headers: { 'content-type': 'text/html' },
      })));
    expect(result.status).toBe('unsupported_media');
    expect(result.reason).toBe('pdf_not_supported');
    expect(result.bytes).toHaveLength(0);
    expect(meter.usage.receivedBytes).toBeLessThan(1000);
    expect(cancelled).toBe(true);
  });

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

  it('retains proxy DNS uncertainty if an earlier redirect hop used a proxy', async () => {
    const result = await fetchSource({ url: 'https://docs.example/start', budget: budget(),
      signal: new AbortController().signal }, {
      resolveProxy: async (url) => url.endsWith('/start') ? 'PROXY proxy.example:8080' : 'DIRECT',
      resolveDns: publicDns,
      httpClient: async (url) => url.endsWith('/start')
        ? new Response(null, { status: 302, headers: { location: 'https://docs.example/final' } })
        : new Response('body', { headers: { 'content-type': 'text/plain' } }),
    });
    expect(result.status).toBe('readable');
    expect(result.assurance).toBe('proxy_dns_unverified');
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

  it('does not request a redirect target explicitly labeled PDF', async () => {
    const client = vi.fn(async () => new Response(null, { status: 302,
      headers: { location: 'https://docs.example/paper.pdf' } }));
    const result = await fetchSource({ url: 'https://docs.example/start', budget: budget(),
      signal: new AbortController().signal }, deps(client));
    expect(result.status).toBe('unsupported_media');
    expect(result.reason).toBe('pdf_url_excluded');
    expect(client).toHaveBeenCalledTimes(1);
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
