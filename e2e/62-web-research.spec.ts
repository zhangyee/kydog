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
 * One packaged main path: IAB search observations feed the durable task queue, then
 * fetched HTML becomes evidence and a Markdown report in the project.
 * No request can leave the fixture proxy; model replies also come from a local fixture.
 */
const hosts = ['example.com', 'example.org', 'example.net',
  'www.duckduckgo.com', 'www.bing.com', 'www.google.com'];
const certPath = path.resolve(__dirname, 'fixtures/61-browser/tls-cert.pem');
const cert = readFileSync(certPath);
const key = readFileSync(path.resolve(__dirname, 'fixtures/61-browser/tls-key.pem'));
const query = 'KyDog research test';
const serps = {
  duckduckgo: 'https://www.duckduckgo.com/search?q=KyDog',
  bing: 'https://www.bing.com/search?q=KyDog',
  google: 'https://www.google.com/challenge?q=KyDog',
};
const articles = {
  first: 'https://example.com/article-first',
  shared: 'https://example.net/article-shared',
  last: 'https://example.org/article-last',
};

function pageFor(host: string, pathname: string): { type: string; body: string } {
  if (pathname === '/search') {
    const items = host === 'www.duckduckgo.com'
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

async function runCalls(page: Page, fixturePath: string, calls: Call[], createThread = true) {
  await fs.writeFile(fixturePath, JSON.stringify(script(calls)));
  await page.evaluate(() => {
    const box = { chunks: [] as Array<{ toolCallId: string; chunk: string }>,
      ends: [] as Array<{ toolCallId: string; status: string }>, ended: null as null | string };
    (window as unknown as { __webResearchRun: typeof box }).__webResearchRun = box;
    window.kydog.on('run.tool_call_chunk', (event) => box.chunks.push({ toolCallId: event.toolCallId, chunk: event.chunk }));
    window.kydog.on('run.tool_call_end', (event) => box.ends.push({ toolCallId: event.toolCallId, status: event.status }));
    window.kydog.on('run.ended', (event) => { box.ended = event.reason; });
  });
  if (createThread) await newThread(page);
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

test('IAB observations feed a durable task and saved Markdown report through the packaged app', async () => {
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
    const searchCalls: Call[] = [
      { toolCallId: 'open-ddg', name: 'browser_open', args: { tabId: tab1.tabId, url: serps.duckduckgo } },
      { toolCallId: 'extract-ddg', name: 'browser_act', args: { tabId: tab1.tabId,
        actions: [{ kind: 'extract', selectors: { item: '.hit', title: '.title',
          url: '.title@href', snippet: '.snippet' } }],
        research: { engineId: 'duckduckgo', query, angleIds: ['a1'] } } },
      { toolCallId: 'open-bing', name: 'browser_open', args: { tabId: tab2.tabId, url: serps.bing } },
      { toolCallId: 'extract-bing', name: 'browser_act', args: { tabId: tab2.tabId,
        actions: [{ kind: 'extract', selectors: { item: '.hit', title: '.title',
          url: '.title@href', snippet: '.snippet' } }],
        research: { engineId: 'bing', query, angleIds: ['a1'] } } },
      { toolCallId: 'open-challenge', name: 'browser_open', args: { tabId: tab3.tabId, url: serps.google } },
      { toolCallId: 'record-challenge', name: 'browser_act', args: { tabId: tab3.tabId,
        actions: [{ kind: 'extract', selectors: { item: '.hit', title: '.title', url: '.title@href' } }],
        research: { engineId: 'google', query, angleIds: ['a1'], status: 'blocked' } } },
    ];
    const search = await runCalls(page, fixturePath, searchCalls);
    for (const call of searchCalls) expect(search.get(call.toolCallId)?.status,
      `${call.name}: ${search.get(call.toolCallId)?.text.slice(0, 500)}`).toBe('ok');
    const observationId = (toolCallId: string) => {
      const id = /研究观察 ([0-9a-f-]{36})/.exec(search.get(toolCallId)!.text)?.[1];
      expect(id, `${toolCallId} must save a search observation`).toBeTruthy();
      return id!;
    };
    const observationIds = ['extract-ddg', 'extract-bing', 'record-challenge'].map(observationId);
    expect(search.get('open-challenge')!.text).toContain('Verify you are human');
    const submitCalls: Call[] = [
      { toolCallId: 'submit', name: 'web_research_task', args: { action: 'submit',
        originalQuestion: 'How does the HTML research flow work?',
        angles: [{ id: 'a1', label: 'HTML research flow', query }],
        observationIds, budget: { fetchConcurrency: 2, modelConcurrency: 1 },
      } },
    ];
    const results = await runCalls(page, fixturePath, submitCalls, false);
    for (const call of submitCalls) expect(results.get(call.toolCallId)?.status,
      `${call.name}: ${results.get(call.toolCallId)?.text.slice(0, 500)}`).toBe('ok');
    const submitted = JSON.parse(results.get('submit')!.text) as {
      researchRunId: string; accepted: number; duplicates: number;
      snapshot: { threadId: string; counts: { discoveries: number } };
    };
    expect(submitted).toMatchObject({ accepted: 4, duplicates: 1,
      snapshot: { counts: { discoveries: 5 } } });
    const taskArgs = { threadId: submitted.snapshot.threadId, researchRunId: submitted.researchRunId };
    await expect.poll(async () => page.evaluate((args) => window.kydog.invoke('webResearch.taskGet', args), taskArgs),
      { timeout: 60_000 }).toMatchObject({ counts: { completed: 3, failed: 1 } });
    const sources = await page.evaluate((args) => window.kydog.invoke('webResearch.taskInspect', args),
      { ...taskArgs, view: 'sources' as const });
    const sourceItems = sources.items as Array<{ requestedUrl: string; status: string; reason?: string }>;
    expect(sourceItems.map((source) => source.requestedUrl).sort()).toEqual(
      [...Object.values(articles), 'https://example.com/paper.pdf'].sort());
    expect(sourceItems.find((source) => source.requestedUrl.endsWith('/paper.pdf')))
      .toMatchObject({ status: 'failed', reason: 'pdf_url_excluded' });
    const claims = await page.evaluate((args) => window.kydog.invoke('webResearch.taskInspect', args),
      { ...taskArgs, view: 'claims' as const });
    expect(claims.items).toHaveLength(3);
    const claimItems = claims.items as Array<{ evidence: Array<{ evidenceId: string }> }>;
    const firstEvidenceId = claimItems[0].evidence[0].evidenceId;
    const evidence = await page.evaluate((args) => window.kydog.invoke('webResearch.taskInspect', args),
      { ...taskArgs, view: 'evidence' as const, evidenceIds: [firstEvidenceId] });
    const evidenceItem = evidence.items[0] as { excerpt: string; finalUrl: string };
    expect(evidenceItem.excerpt).toContain('confirms the research workflow');
    const finalUrl = evidenceItem.finalUrl;
    const report = `# HTML research flow\n\nThe source confirms the research workflow. [来源](${finalUrl})〔证据:${firstEvidenceId}〕\n`;
    const finish = await runCalls(page, fixturePath, [{ toolCallId: 'complete', name: 'web_research_task',
      args: { action: 'complete', researchRunId: submitted.researchRunId,
        reportMarkdown: report, fileName: 'html-research-flow.md' } }], false);
    expect(finish.get('complete')?.status, finish.get('complete')?.text).toBe('ok');
    const completed = JSON.parse(finish.get('complete')!.text) as { reportPath: string };
    expect(await fs.readFile(completed.reportPath, 'utf8'))
      .toBe(`# HTML research flow\n\nThe source confirms the research workflow. [来源](${finalUrl})\n`);
    await expect(page.getByTestId('research-task-card')).toHaveAttribute('data-status', 'completed');
    const reportCard = page.getByTestId(`file-card-${completed.reportPath}`);
    await expect(reportCard).toBeVisible();
    await expect(page.getByTestId('research-task-card').getByTestId(`file-card-${completed.reportPath}`))
      .toHaveCount(0);
    await page.reload();
    await expect.poll(async () => page.evaluate((args) => window.kydog.invoke('webResearch.taskGet', args), taskArgs))
      .toMatchObject({ status: 'completed', reportPath: completed.reportPath });
    const runRoot = path.join(launched.kydogHome, '.kydog', 'web-research');
    const task = JSON.parse(await fs.readFile(path.join(runRoot, taskArgs.threadId,
      submitted.researchRunId, 'task.json'), 'utf8')) as {
      attempts: Array<{ status: string }>;
    };
    expect(task.attempts.map((attempt) => attempt.status)).toEqual(['results', 'results', 'blocked']);
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
