import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { readFileSync, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import tls from 'node:tls';
import type { AddressInfo, Socket } from 'node:net';
import { buildNetworkHarness } from './fixtures/61-browser/buildNetworkHarness';
import { NETWORK_BODY, networkPage } from './fixtures/61-browser/networkPages';
import type { NetworkHarnessResult } from './fixtures/61-browser/networkHarnessMain';

// One real Electron launch per repetition: fresh + existing tabs, optional local
// body replay, then destructive lifecycle checks last. Only this test Node process
// reads the local body; the production BrowserService receives it through fetch.
const capturePath = process.env.KYDOG_X_CAPTURE_BODY;
const cert = readFileSync(path.join(__dirname, 'fixtures/61-browser/tls-cert.pem'), 'utf8');
const key = readFileSync(path.join(__dirname, 'fixtures/61-browser/tls-key.pem'));

test.describe('production BrowserService network capture (offline)', () => {
  test.describe.configure({ mode: 'serial' });
  let electron: ElectronApplication, proxy: http.Server, dir: string, harnessDir: string;
  let topBody: Buffer | undefined;
  const sockets = new Set<Socket>(), held = new Map<string, http.ServerResponse>(), released = new Set<string>();
  const cleanup = async () => {
    try { if (electron) await electron.close(); }
    finally {
      for (const socket of sockets) socket.destroy();
      if (proxy?.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
      if (harnessDir) await fs.rm(harnessDir, { recursive: true, force: true });
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  };
  // Playwright requires destructuring its fixture argument.
  // eslint-disable-next-line no-empty-pattern
  test.beforeAll(async ({}, info) => {
    if (capturePath) topBody = readFileSync(capturePath);
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-network-'));
    const origin = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'https://example.org');
      const name = url.pathname.split('/')[2];
      if (url.pathname.startsWith('/hold/')) {
        res.setHeader('content-type', 'application/javascript');
        if (released.has(name)) res.end('/* released */'); else held.set(name, res);
      } else if (url.pathname.startsWith('/release/')) {
        released.add(name); held.get(name)?.end('/* released */'); held.delete(name); res.end('released');
      } else if (url.pathname.startsWith('/body/')) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(name === 'top' ? topBody : NETWORK_BODY);
      } else if (url.pathname.startsWith('/page/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(networkPage(name));
      } else { res.writeHead(404); res.end(); }
    });
    origin.on('clientError', (_error, socket) => socket.destroy());
    proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
    proxy.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
    proxy.on('connect', (req, socket: Socket, head) => {
      if (req.url !== 'example.org:443') { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) socket.unshift(head);
      origin.emit('connection', new tls.TLSSocket(socket, { isServer: true, key, cert, ALPNProtocols: ['http/1.1'] }));
    });
    try {
      await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
      harnessDir = info.outputPath('network-harness');
      const entry = await buildNetworkHarness(harnessDir);
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)); delete env.ELECTRON_RUN_AS_NODE; delete env.KYDOG_X_CAPTURE_BODY;
      electron = await _electron.launch({ args: [entry, `--user-data-dir=${dir}`, '--force-device-scale-factor=1', '--force-prefers-no-reduced-motion',
        ...(process.platform === 'darwin' ? ['-AppleShowScrollBars', 'Always'] : [])], env, timeout: 20000 });
      await electron.firstWindow();
      await expect.poll(() => electron.evaluate(() => !!globalThis.networkHarness)).toBe(true);
      await electron.evaluate((_electron, args) => globalThis.networkHarness.configure(args.port, args.cert), { port: (proxy.address() as AddressInfo).port, cert });
    } catch (error) { await cleanup(); throw error; }
  });
  test.afterAll(cleanup);

  function verify(result: NetworkHarnessResult, expected: Buffer, fresh: boolean) {
    console.info('[network-capture-result]', JSON.stringify({ history: result.history, trace: result.trace, events: result.events.map(({ body: _body, ...event }) => event) }));
    expect(result.events.map(e => e.kind)).toEqual(['request', 'response']);
    const response = result.events[1];
    expect(response.bytes).toBe(expected.length);
    expect(response.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(response.navigationId).toMatch(/^\[null,".+",".+"\]$/);
    const body = result.trace.find(t => t.event === 'body-settled');
    const opened = result.trace.find(t => t.event === 'open-resolved');
    const enabled = result.trace.find(t => t.method === 'Network.enable');
    const committed = result.trace.find(t => t.event === 'target-committed');
    expect(body).toBeDefined(); expect(opened).toBeDefined(); expect(enabled).toBeDefined(); expect(committed).toBeDefined();
    expect(enabled!.seq).toBeLessThan(committed!.seq);
    expect(body!.seq).toBeLessThan(opened!.seq);
    const commands = result.trace.filter(t => t.event === 'command');
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every(t => t.pid! > 0)).toBe(true);
    if (fresh) {
      expect(result.trace.find(t => t.event === 'created')?.pid).toBe(0);
      expect(result.history.urls).toHaveLength(1);
      expect(result.history.canGoBack).toBe(false);
    }
  }

  test('new pid-zero tab and existing tab capture exact UTF8 body before open resolves', async () => {
    const first = await electron.evaluate(() => globalThis.networkHarness.capture('fresh'));
    verify(first, Buffer.from(NETWORK_BODY), true); expect(first.events[1].body).toBe(NETWORK_BODY);
    const second = await electron.evaluate((_e, id) => globalThis.networkHarness.capture('existing', id), first.tabId);
    verify(second, Buffer.from(NETWORK_BODY), false); expect(second.events[1].body).toBe(NETWORK_BODY);
    expect(second.history).toEqual({ canGoBack: true, urls: ['https://example.org/page/fresh', 'https://example.org/page/existing'] });
  });

  test('optional local Top body replays exact decoded byte count and SHA256', async () => {
    test.skip(!capturePath, 'Local private replay only; generic UTF8 channel always runs.');
    expect(topBody!.length).toBe(159836);
    expect(createHash('sha256').update(topBody!).digest('hex')).toBe('974879ed64cf48f991a8ed21a3ef59490c48b84b572122a6c13d805581401bbd');
    const result = await electron.evaluate(() => globalThis.networkHarness.capture('top'));
    verify(result, topBody!, true);
  });

  test('real debugger detach and renderer crash close a previously successful capture waiter', async () => {
    for (const kind of ['detach', 'crash'] as const) {
      const captured = await electron.evaluate((_e, k) => globalThis.networkHarness.capture(k), kind);
      verify(captured, Buffer.from(NETWORK_BODY), true);
      const ended = await electron.evaluate((_e, k) => globalThis.networkHarness.end(k), kind);
      expect(ended.closed).toBe('closed');
    }
  });
});
