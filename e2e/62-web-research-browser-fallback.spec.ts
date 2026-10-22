import { test, expect } from '@playwright/test';
import { readFileSync, promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { BROWSER_PARTITION } from '../src/main/browser/partition';
import type { WebResearchTaskSource } from '../src/shared/webResearchTask';
import { launchKydog, newThread, seedProject, seedSamplePackage, teardown } from './helpers';
import { runCalls } from './fixtures/62-web-research-browser-fallback/driver';

/** One feature launch, in order: dynamic InfoQ → cookie/reload CSDN → manual verification.
 * The model fixture is consumed in that order. Browser/HTTP traffic cannot leave the allowlist
 * proxy. Disabling fallback must break case 1; refreshing capture_existing must break case 3.
 */
const fixtureRoot = path.resolve(__dirname, 'fixtures/62-web-research-browser-fallback');
const hosts = ['example.com', 'example.org', 'www.duckduckgo.com', 'xie.infoq.cn', 'blog.csdn.net'];
const certPath = path.join(fixtureRoot, 'tls-cert.pem');
const cert = readFileSync(certPath);
const key = readFileSync(path.join(fixtureRoot, 'tls-key.pem'));
const urls = {
  infoq: 'https://xie.infoq.cn/article/dynamic-fixture',
  csdn: 'https://blog.csdn.net/fixture/article/details/521',
  verify: 'https://example.org/verification',
};
type RequestFact = { host: string; path: string; cookie: string; status: number };
async function startProxy() {
  const requests: RequestFact[] = [];
  const origin = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const pathname = (req.url ?? '/').split('?')[0];
    const cookie = req.headers.cookie ?? '';
    let body = '<!doctype html><html><head><title>User page</title></head><body><main>User document remains here.</main></body></html>';
    let status = 200;
    if (!hosts.includes(host)) { res.writeHead(403); res.end(); return; }
    if (pathname === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    if (host === 'www.duckduckgo.com') {
      const target = urls[pathname.slice(1) as keyof typeof urls];
      if (!target) { res.writeHead(404); res.end(); return; }
      body = `<!doctype html><html><head><title>Search</title></head><body><main><article class="hit"><a href="${target}">Browser research source</a></article></main></body></html>`;
    } else if (host === 'xie.infoq.cn') {
      body = pathname === '/article-fragment'
        ? '<div class="article-detaile"><div class="article-preview"><h1>Dynamic article</h1><p>Dynamic rendering supplies grounded evidence for the research workflow from an actual article root.</p></div></div>'
        : readFileSync(path.join(fixtureRoot, 'infoq.html'), 'utf8');
    } else if (host === 'blog.csdn.net') {
      status = cookie.includes('fixture_clearance=accepted') ? 200 : 521;
      body = status === 521 ? readFileSync(path.join(fixtureRoot, 'challenge.html'), 'utf8')
        : '<!doctype html><html><head><title>CSDN article</title></head><body><div id="content_views"><h1>Cookie article</h1><p>Cookie reload supplies grounded evidence for the research workflow after the challenge script executes.</p></div></body></html>';
    } else if (pathname === '/verification') body = readFileSync(path.join(fixtureRoot, 'verification.html'), 'utf8');
    requests.push({ host, path: pathname, cookie, status });
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body);
  });
  origin.on('clientError', (_error, socket) => socket.destroy());
  const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  const sockets = new Set<Socket>();
  proxy.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  proxy.on('connect', (req, socket, head) => {
    socket.on('error', () => {});
    const match = /^([^:]+):(\d+)$/.exec(req.url ?? '');
    if (!match || !hosts.includes(match[1].toLowerCase()) || match[2] !== '443') {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    origin.emit('connection', new tls.TLSSocket(socket, { isServer: true, key, cert, ALPNProtocols: ['http/1.1'] }));
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return { port: (proxy.address() as AddressInfo).port, requests,
    close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); proxy.close(() => resolve()); }) };
}

test.describe('packaged research browser fallback', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: Awaited<ReturnType<typeof launchKydog>>;
  let proxy: Awaited<ReturnType<typeof startProxy>>;
  let projectPath: string, fixtureDir: string, agentPath: string;
  let userTabId: string, controlTabId: string;
  test.beforeAll(async () => {
    proxy = await startProxy();
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-fallback-project-'));
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-fallback-fixture-'));
    agentPath = path.join(fixtureDir, 'agent.json');
    await fs.writeFile(agentPath, JSON.stringify({ events: [] }));
    await seedSamplePackage(projectPath);
    launched = await launchKydog({ fixture: agentPath, seed: (home) => seedProject(home, projectPath),
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: '', no_proxy: '', NODE_EXTRA_CA_CERTS: certPath,
        KYDOG_WEB_RESEARCH_FIXTURE: path.join(fixtureRoot, 'model.json') } });
    const route = await launched.app.evaluate(async ({ session }, args) => {
      const browser = session.fromPartition(args.partition);
      await browser.setProxy({ proxyRules: `http://127.0.0.1:${args.port}` });
      const flat = (pem: string) => pem.replace(/\s+/g, '');
      browser.setCertificateVerifyProc((request, callback) => callback(args.hosts.includes(request.hostname)
        && flat(request.certificate.data) === flat(args.cert) ? 0 : -3));
      return browser.resolveProxy(args.url);
    }, { partition: BROWSER_PARTITION, port: proxy.port, hosts, cert: cert.toString('utf8'), url: urls.csdn });
    expect(route).toBe(`PROXY 127.0.0.1:${proxy.port}`);
    await newThread(launched.page);
    userTabId = (await launched.page.evaluate(() => window.kydog.invoke('browser.open', { url: 'https://example.com/user' }))).tabId;
    controlTabId = (await launched.page.evaluate(() => window.kydog.invoke('browser.open', { url: 'https://example.com/control' }))).tabId;
  });
  test.afterEach(async () => {
    if (!launched) return;
    // Preserve protocol facts even when a mutation fails before the success assertions.
    const output = test.info().outputPath('research-records');
    await fs.cp(path.join(launched.kydogHome, '.kydog', 'web-research'), output, { recursive: true });
    await fs.writeFile(test.info().outputPath('request-facts.json'), JSON.stringify(proxy.requests, null, 2));
    await fs.writeFile(test.info().outputPath('browser-state.json'), JSON.stringify(await browserState(), null, 2));
  });
  test.afterAll(async () => {
    if (proxy) await test.info().attach('fixture-requests', { body: JSON.stringify(proxy.requests, null, 2), contentType: 'application/json' });
    if (launched) { await teardown(launched); await fs.rm(launched.kydogHome, { recursive: true, force: true }); }
    if (proxy) await proxy.close();
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
    if (projectPath) await fs.rm(projectPath, { recursive: true, force: true });
  });
  const browserState = () => launched.page.evaluate(() => window.kydog.invoke('browser.getState'));
  async function activateControlThenUser() {
    // Same-case positive control proves activation is observable before asserting background work preserves it.
    await launched.page.evaluate((tabId) => window.kydog.invoke('browser.activate', { tabId }), controlTabId);
    expect((await browserState()).activeTabId).toBe(controlTabId);
    await launched.page.evaluate((tabId) => window.kydog.invoke('browser.activate', { tabId }), userTabId);
    expect((await browserState()).activeTabId).toBe(userTabId);
  }
  async function submit(kind: keyof typeof urls) {
    const search = await runCalls(launched.page, agentPath, [
      { toolCallId: 'search-open', name: 'browser_open', args: { tabId: controlTabId, url: `https://www.duckduckgo.com/${kind}` } },
      { toolCallId: 'observe', name: 'browser_act', args: { tabId: controlTabId,
        actions: [{ kind: 'extract', selectors: { item: '.hit', title: 'a', url: 'a@href' } }],
        research: { engineId: 'duckduckgo', query: kind, angleIds: ['a1'] } } },
    ], false);
    for (const result of search.values()) expect(result.status, result.text).toBe('ok');
    const observationId = /研究观察 ([0-9a-f-]{36})/.exec(search.get('observe')!.text)![1];
    await activateControlThenUser();
    const result = await runCalls(launched.page, agentPath, [{ toolCallId: 'submit', name: 'web_research_task', args: {
      action: 'submit', originalQuestion: `Browser fallback ${kind}`, angles: [{ id: 'a1', label: kind, query: kind }],
      observationIds: [observationId], budget: { fetchConcurrency: 1, modelConcurrency: 1 },
    } }], false);
    expect(result.get('submit')!.status, result.get('submit')!.text).toBe('ok');
    const submitted = JSON.parse(result.get('submit')!.text) as { researchRunId: string; snapshot: { threadId: string } };
    const args = { researchRunId: submitted.researchRunId, threadId: submitted.snapshot.threadId };
    const directory = path.join(launched.kydogHome, '.kydog', 'web-research', args.threadId, args.researchRunId, 'task-sources');
    const readSource = async () => {
      const files = (await fs.readdir(directory)).filter(name => name.endsWith('.json'));
      expect(files).toHaveLength(1);
      return JSON.parse(await fs.readFile(path.join(directory, files[0]), 'utf8')) as WebResearchTaskSource;
    };
    const initial = await readSource();
    expect(initial.requestedUrl).toBe(urls[kind]);
    return { args, readSource, sourceId: initial.sourceId };
  }
  async function grounded(task: Awaited<ReturnType<typeof submit>>) {
    await expect.poll(async () => (await task.readSource()).status).toBe('completed');
    const source = await task.readSource();
    expect(source.sourceId).toBe(task.sourceId);
    expect(source.extraction!.evidence[0].verification).toBe('grounded');
    expect(source.extraction!.evidence[0].sourceId).toBe(task.sourceId);
    expect((await browserState()).activeTabId).toBe(userTabId);
    await test.info().attach('source-facts', { body: JSON.stringify(source, null, 2), contentType: 'application/json' });
    return source;
  }
  test('InfoQ dynamic article root enters grounded evidence with the same source identity', async () => {
    const task = await submit('infoq');
    const source = await grounded(task);
    expect(source.statusCode).toBe(200);
    expect(source.browser!.attempts.at(-1)!.document!.rootRule).toBe('.article-detaile .article-preview');
    expect(source.browser!.attempts.at(-1)!.navigationMode).toBe('navigate');
    expect(proxy.requests.filter(r => r.host === 'xie.infoq.cn').map(r => r.path))
      .toContain('/article-fragment');
  });
  test('CSDN 521 script writes a cookie and reloads to browser 200 while retaining HTTP 521', async () => {
    const task = await submit('csdn');
    const source = await grounded(task);
    expect(source.statusCode).toBe(521);
    expect(source.browser!.attempts.at(-1)!.mainStatusCode).toBe(200);
    const requests = proxy.requests.filter(r => r.host === 'blog.csdn.net');
    expect(requests.map(r => r.status)).toEqual([521, 521, 200]);
    expect(requests.map(r => r.cookie)).toEqual(['', '', 'fixture_clearance=accepted']);
  });
  test('waiting source opens from its real card and continues the verified document without navigation', async () => {
    const task = await submit('verify');
    await expect.poll(async () => (await task.readSource()).status).toBe('waiting_user');
    expect((await task.readSource()).reason).toBe('verification_widget');
    expect((await browserState()).activeTabId).toBe(userTabId);
    const card = launched.page.getByTestId('research-task-card').last();
    await card.getByTestId('research-task-toggle').click();
    await expect(card.getByTestId(`research-source-open-${task.sourceId}`)).toBeVisible();
    await card.getByTestId(`research-source-open-${task.sourceId}`).click();
    await expect(launched.page.getByTestId('browser-stage')).toBeVisible();
    const sourceTab = (await browserState()).activeTabId!;
    expect((await browserState()).tabs.find(t => t.id === sourceTab)!.url).toBe(urls.verify);
    await expect(launched.page.getByTestId(`browser-tab-keep-${sourceTab}`)).toBeVisible();
    await launched.page.getByTestId(`browser-tab-keep-${sourceTab}`).click();
    const documentFacts = () => launched.app.evaluate(async ({ webContents }, url) => {
      const views = webContents.getAllWebContents().filter(w => w.getURL() === url);
      if (views.length !== 1) throw new Error(`Expected one verification document, found ${views.length}`);
      return views[0].executeJavaScript('({timeOrigin: performance.timeOrigin, verified: document.documentElement.dataset.verified, text: document.body.innerText})');
    }, urls.verify);
    const requestCount = () => proxy.requests.filter(r => r.path === '/verification').length;
    const beforeReload = requestCount();
    const beforeReloadOrigin = (await documentFacts()).timeOrigin;
    // Positive control in this case: the real reload button adds a document request.
    await launched.page.getByTestId('browser-reload').click();
    await expect.poll(requestCount).toBe(beforeReload + 1);
    // A request is not a document-ready receipt: wait for the replacement document and its button.
    await expect.poll(async () => {
      const document = await documentFacts();
      return document.timeOrigin > beforeReloadOrigin && document.text.includes('完成夹具验证');
    }).toBe(true);
    await launched.app.evaluate(async ({ webContents }, url) => {
      const views = webContents.getAllWebContents().filter(w => w.getURL() === url);
      if (views.length !== 1) throw new Error('Expected one verification document');
      const point = await views[0].executeJavaScript('(() => { const r = document.querySelector("#verify").getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)}; })()');
      views[0].sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      views[0].sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    }, urls.verify);
    await expect.poll(async () => (await documentFacts()).verified).toBe('true');
    const verified = await documentFacts();
    expect(verified.text).toContain('Manual verification preserves the current document');
    const beforeContinue = requestCount();
    await activateControlThenUser();
    await card.getByTestId(`research-source-retry-${task.sourceId}`).click();
    const source = await grounded(task);
    expect(source.browser!.attempts.at(-1)!.navigationMode).toBe('capture_existing');
    expect(requestCount()).toBe(beforeContinue);
    expect((await documentFacts()).timeOrigin).toBe(verified.timeOrigin);
    expect((await documentFacts()).verified).toBe('true');
  });
});
