import { test, expect, type Page } from '@playwright/test';
import { readFileSync, promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { BROWSER_PARTITION } from '../src/main/browser/partition';
import { launchKydog, newThread, seedProject, seedSamplePackage, teardown } from './helpers';

/**
 * One packaged main path: real IAB tools discover results, then the real collector fetches
 * the known URLs through this spec's proxy and executes jsdom/Readability in the package.
 * No request can leave the fixture proxy; model replies also come from a local fixture.
 */
const hosts = ['example.com', 'example.org', 'example.net'];
const certPath = path.resolve(__dirname, 'fixtures/61-browser/tls-cert.pem');
const cert = readFileSync(certPath);
const key = readFileSync(path.resolve(__dirname, 'fixtures/61-browser/tls-key.pem'));
const query = 'KyDog research test';
const serps = {
  duckduckgo: 'https://example.com/search?q=KyDog',
  bing: 'https://example.org/search?q=KyDog',
  google: 'https://example.net/challenge?q=KyDog',
};
const articles = {
  first: 'https://example.com/article-first',
  shared: 'https://example.net/article-shared',
  last: 'https://example.org/article-last',
};

function pageFor(host: string, pathname: string): { type: string; body: string } {
  if (pathname === '/search') {
    const items = host === 'example.com'
      ? [['First', articles.first], ['Shared', articles.shared], ['PDF', 'https://example.com/paper.pdf']]
      : [['Shared', articles.shared], ['Last', articles.last]];
    const rows = items.map(([title, href]) =>
      `<article class="hit"><a class="title" href="${href}">${title}</a><p class="snippet">${title} snippet for ${query}</p></article>`).join('');
    return { type: 'text/html', body: `<!doctype html><html><head><title>Results</title></head><body><main><h1>${query}</h1>${rows}</main></body></html>` };
  }
  if (pathname === '/challenge') return { type: 'text/html', body: '<!doctype html><html><body><h1>Verify you are human</h1><form><input name="captcha"></form></body></html>' };
  if (pathname.startsWith('/article-')) {
    const title = pathname.slice(1);
    return { type: 'text/html', body: `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${title} confirms the research workflow uses a real HTML source and a stable citation URL.</p></main></body></html>` };
  }
  if (pathname === '/paper.pdf') return { type: 'application/pdf', body: '%PDF-1.7\nfixture' };
  return { type: 'text/html', body: '<!doctype html><html><body><main><h1>Bootstrap</h1></main></body></html>' };
}

async function startProxy() {
  const requests: Array<{ host: string; path: string }> = [];
  const origin = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    requests.push({ host, path: pathname });
    const page = pageFor(host, pathname);
    res.writeHead(200, { 'content-type': `${page.type}; charset=utf-8` });
    res.end(page.body);
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
    origin.emit('connection', new tls.TLSSocket(socket, { isServer: true, key, cert,
      ALPNProtocols: ['http/1.1'] }));
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return { port: (proxy.address() as AddressInfo).port, requests,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      proxy.close(() => resolve());
    }) };
}

type Call = { toolCallId: string; name: string; args: Record<string, unknown> };
function script(calls: Call[]) {
  return { events: [
    { after_ms: 5, type: 'agent_start' },
    { after_ms: 5, type: 'message_start', messageId: 'm1' },
    ...calls.map((call) => ({ after_ms: 5, type: 'tool', ...call })),
    { after_ms: 5, type: 'message_end', messageId: 'm1',
      toolCallIds: calls.map((call) => call.toolCallId), toolNames: calls.map((call) => call.name) },
    { after_ms: 5, type: 'agent_end', reason: 'completed' },
  ] };
}

async function runCalls(page: Page, fixturePath: string, calls: Call[]) {
  await fs.writeFile(fixturePath, JSON.stringify(script(calls)));
  await page.evaluate(() => {
    const box = { chunks: [] as Array<{ toolCallId: string; chunk: string }>,
      ends: [] as Array<{ toolCallId: string; status: string }>, ended: null as null | string };
    (window as unknown as { __webResearchRun: typeof box }).__webResearchRun = box;
    window.kydog.on('run.tool_call_chunk', (event) => box.chunks.push({ toolCallId: event.toolCallId, chunk: event.chunk }));
    window.kydog.on('run.tool_call_end', (event) => box.ends.push({ toolCallId: event.toolCallId, status: event.status }));
    window.kydog.on('run.ended', (event) => { box.ended = event.reason; });
  });
  await newThread(page);
  const composer = page.getByTestId('composer-input');
  await expect.poll(async () => { await composer.fill('按夹具执行网页研究'); return composer.textContent(); })
    .toBe('按夹具执行网页研究');
  await page.getByTestId('send-button').click();
  const read = () => page.evaluate(() => (window as unknown as { __webResearchRun: {
    chunks: Array<{ toolCallId: string; chunk: string }>;
    ends: Array<{ toolCallId: string; status: string }>;
    ended: null | string;
  } }).__webResearchRun);
  await expect.poll(async () => (await read()).ended, { timeout: 60_000 }).toBe('completed');
  const box = await read();
  return new Map(calls.map((call) => {
    const end = box.ends.find((item) => item.toolCallId === call.toolCallId);
    expect(end, `${call.name} must emit run.tool_call_end`).toBeTruthy();
    return [call.toolCallId, { status: end!.status,
      text: box.chunks.filter((item) => item.toolCallId === call.toolCallId)
        .map((item) => item.chunk).join('') }] as const;
  }));
}

test('IAB search results feed one deduplicated HTML-only collect through the packaged app', async () => {
  const proxy = await startProxy();
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-web-research-project-'));
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-web-research-fixture-'));
  const fixturePath = path.join(fixtureDir, 'agent.json');
  const modelPath = path.join(fixtureDir, 'model.json');
  await seedSamplePackage(projectPath);
  await fs.writeFile(modelPath, JSON.stringify(Array.from({ length: 3 }, () => ({ stopReason: 'stop',
    text: JSON.stringify({ status: 'claims', claims: [{ statement: 'The HTML source confirms the research workflow',
      relevantAngleIds: ['a1'], evidence: [{ passageId: '{{passageId:confirms the research workflow}}',
        quote: 'confirms the research workflow', relation: 'supports' }] }], gaps: [] }) }))));
  let launched: Awaited<ReturnType<typeof launchKydog>> | undefined;
  try {
    launched = await launchKydog({ fixture: fixturePath, seed: (home) => seedProject(home, projectPath),
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: '', no_proxy: '', NODE_EXTRA_CA_CERTS: certPath, KYDOG_WEB_RESEARCH_FIXTURE: modelPath } });
    const { app, page } = launched;
    const route = await app.evaluate(async ({ session }, args) => {
      const browser = session.fromPartition(args.partition);
      await browser.setProxy({ proxyRules: `http://127.0.0.1:${args.port}` });
      const flat = (pem: string) => pem.replace(/\s+/g, '');
      browser.setCertificateVerifyProc((request, callback) => {
        callback(args.hosts.includes(request.hostname) && flat(request.certificate.data) === flat(args.cert) ? 0 : -3);
      });
      return browser.resolveProxy(args.url);
    }, { partition: BROWSER_PARTITION, port: proxy.port, hosts, cert: cert.toString('utf8'), url: serps.duckduckgo });
    expect(route).toBe(`PROXY 127.0.0.1:${proxy.port}`);

    const tab1 = await page.evaluate(() => window.kydog.invoke('browser.open', { url: 'https://example.com/bootstrap' }));
    const tab2 = await page.evaluate(() => window.kydog.invoke('browser.open', { url: 'https://example.org/bootstrap' }));
    const tab3 = await page.evaluate(() => window.kydog.invoke('browser.open', { url: 'https://example.net/bootstrap' }));
    const attempts = [
      { attemptId: 'ddg-1', angleIds: ['a1'], engineId: 'duckduckgo', query,
        searchPageUrl: serps.duckduckgo, status: 'results' },
      { attemptId: 'bing-1', angleIds: ['a1'], engineId: 'bing', query,
        searchPageUrl: serps.bing, status: 'results' },
      { attemptId: 'google-1', angleIds: ['a1'], engineId: 'google', query,
        searchPageUrl: serps.google, status: 'blocked', reason: 'captcha' },
    ];
    const searchCalls: Call[] = [
      { toolCallId: 'open-ddg', name: 'browser_open', args: { tabId: tab1.tabId, url: serps.duckduckgo } },
      { toolCallId: 'extract-ddg', name: 'browser_act', args: { tabId: tab1.tabId,
        actions: [{ kind: 'extract', selectors: { item: '.hit', title: '.title',
          url: '.title@href', snippet: '.snippet' } }] } },
      { toolCallId: 'open-bing', name: 'browser_open', args: { tabId: tab2.tabId, url: serps.bing } },
      { toolCallId: 'extract-bing', name: 'browser_act', args: { tabId: tab2.tabId,
        actions: [{ kind: 'extract', selectors: { item: '.hit', title: '.title',
          url: '.title@href', snippet: '.snippet' } }] } },
      { toolCallId: 'open-challenge', name: 'browser_open', args: { tabId: tab3.tabId, url: serps.google } },
    ];
    const search = await runCalls(page, fixturePath, searchCalls);
    for (const call of searchCalls) expect(search.get(call.toolCallId)?.status,
      `${call.name}: ${search.get(call.toolCallId)?.text.slice(0, 500)}`).toBe('ok');
    const extractedUrls = (toolCallId: string) => Array.from(
      search.get(toolCallId)!.text.matchAll(/"url":\s*"(https:\/\/[^"\s]+)"/g), (match) => match[1]);
    expect(extractedUrls('extract-ddg')).toEqual([articles.first, articles.shared,
      'https://example.com/paper.pdf']);
    expect(extractedUrls('extract-bing')).toEqual([articles.shared, articles.last]);
    expect(search.get('open-challenge')!.text).toContain('Verify you are human');
    const discovered = [
      ...extractedUrls('extract-ddg')
        .map((resultUrl) => ({ attemptId: 'ddg-1', angleId: 'a1', engineId: 'duckduckgo',
          query, searchPageUrl: serps.duckduckgo, resultUrl })),
      ...extractedUrls('extract-bing').map((resultUrl) => ({ attemptId: 'bing-1',
        angleId: 'a1', engineId: 'bing', query, searchPageUrl: serps.bing, resultUrl })),
    ];
    // The second fixture session is built only after the real IAB results are observed, so
    // collect receives the URLs returned by browser_act rather than a parallel hard-coded list.
    const collectCalls: Call[] = [
      { toolCallId: 'collect', name: 'web_research_collect', args: {
        originalQuestion: 'How does the HTML research flow work?',
        angles: [{ id: 'a1', label: 'HTML research flow', query }],
        enabledEngines: ['duckduckgo', 'bing', 'google'], attempts,
        discoveries: discovered, budget: { fetchConcurrency: 2, modelConcurrency: 1 },
      } },
    ];
    const results = await runCalls(page, fixturePath, collectCalls);
    for (const call of collectCalls) expect(results.get(call.toolCallId)?.status,
      `${call.name}: ${results.get(call.toolCallId)?.text.slice(0, 500)}`).toBe('ok');
    const collected = JSON.parse(results.get('collect')!.text) as {
      researchRunId: string;
      angles: Array<{ claims: Array<{ verification: string; supportingEvidenceIds: string[] }> }>;
      sources: Array<{ requestedUrl: string; status: string; reason?: string }>;
      attempts: Array<{ status: string }>;
      usage: { fetchesDispatched: number; modelCalls: number };
    };
    expect(collected.sources.map((source) => source.requestedUrl).sort()).toEqual(
      [...Object.values(articles), 'https://example.com/paper.pdf'].sort());
    expect(collected.sources.filter((source) => source.status === 'completed')).toHaveLength(3);
    expect(collected.sources.find((source) => source.requestedUrl.endsWith('/paper.pdf')))
      .toMatchObject({ status: 'failed', reason: 'pdf_url_excluded' });
    expect(collected.attempts.map((attempt) => attempt.status)).toEqual(['results', 'results', 'blocked']);
    expect(collected.usage.fetchesDispatched).toBe(3);
    expect(collected.usage.modelCalls).toBe(3);
    expect(collected.angles[0].claims).toHaveLength(3);
    expect(collected.angles[0].claims.every((claim) => claim.verification === 'grounded' &&
      claim.supportingEvidenceIds.length === 1)).toBe(true);
    const runRoot = path.join(launched.kydogHome, '.kydog', 'web-research');
    const threadIds = await fs.readdir(runRoot);
    expect(threadIds).toHaveLength(1);
    const run = JSON.parse(await fs.readFile(path.join(runRoot, threadIds[0],
      collected.researchRunId, 'run.json'), 'utf8')) as {
      candidates: Array<{ requestedUrl: string; discoveries: Array<{ engineId: string }> }>;
    };
    const shared = run.candidates.find((candidate) => candidate.requestedUrl === articles.shared);
    expect(shared?.discoveries.map((item) => item.engineId).sort()).toEqual(['bing', 'duckduckgo']);
    const evidence = await page.evaluate((args) => window.kydog.invoke('webResearch.evidence', args), {
      threadId: threadIds[0], researchRunId: collected.researchRunId,
      evidenceId: collected.angles[0].claims[0].supportingEvidenceIds[0],
    });
    expect(evidence.verification).toBe('grounded');
    expect(evidence.excerpt).toContain('confirms the research workflow');
    expect(Object.values(articles)).toContain(evidence.finalUrl);
    expect(proxy.requests.filter((request) => request.path.startsWith('/article-'))).toHaveLength(3);
    expect(proxy.requests.filter((request) => request.path === '/paper.pdf')).toHaveLength(0);
  } finally {
    if (launched) await teardown(launched);
    if (launched) await fs.rm(launched.kydogHome, { recursive: true, force: true });
    await proxy.close();
    await fs.rm(fixtureDir, { recursive: true, force: true });
    await fs.rm(projectPath, { recursive: true, force: true });
  }
});
