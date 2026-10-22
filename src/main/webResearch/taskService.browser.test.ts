import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebResearchTaskService, type TaskDeps } from './taskService';
import { TaskStore } from './taskStore';
import { DEFAULT_WEB_RESEARCH_TASK_BUDGET, type WebResearchTaskRecord, type WebResearchTaskSource } from '../../shared/webResearchTask';
import type { BrowserReader, BrowserLeaseUnavailable, ResearchDocumentSnapshot } from './browserReadTypes';
import { extractBody } from './extractBody';
import { evidencePublicationState } from './report';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const html = '<html><body><article><p>The architecture uses parallel threads with isolated queues.</p></article></body></html>';
const doc = (url: string, content = html): ResearchDocumentSnapshot => ({ html: content, url,
  identity: { documentEpoch: 3, routeRevision: 2, navigationSequence: 7 },
  rootRule: 'article', utf8Bytes: Buffer.byteLength(content), mainStatusCode: 200 });
function reader(read: BrowserReader['read']): BrowserReader {
  return { read, openForUser: async () => ({ tabId: 'tab', leaseId: 'lease' }), currentTab: () => 'tab',
    release: async () => {}, dispose: async () => {} };
}
async function harness(options: { url?: string; budget?: Partial<WebResearchTaskRecord['budget']>; browser?: BrowserReader; deps?: Partial<TaskDeps> } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'kydog-browser-task-')); roots.push(root);
  const store = new TaskStore(root), now = new Date().toISOString();
  const task: WebResearchTaskRecord = { threadId: randomUUID(), researchRunId: randomUUID(),
    createdByRunId: randomUUID(), projectRoot: root, originalQuestion: 'What architecture is used?',
    createdAt: now, updatedAt: now, revision: 1, status: 'running',
    angles: [{ id: 'architecture', label: 'Architecture', query: 'architecture' }], attempts: [],
    observationIds: [], discoveryCount: 0, budget: { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET, ...options.budget },
    usage: { candidates: 1, fetchesDispatched: 0, receivedBytes: 0, modelCalls: 0 } };
  const source: WebResearchTaskSource = { sourceId: randomUUID(), requestedUrl: options.url ?? 'https://www.infoq.cn/article/architecture',
    status: 'queued', createdAt: now, updatedAt: now, discoveries: [], passages: [] };
  await store.createTask(task); await store.saveSource(task, source);
  const deps: TaskDeps = { store,
    fetch: async ({ url, sourceId, budget }) => {
      const bytes = Buffer.from('<html><body><script src="app.js"></script></body></html>');
      expect(budget.reserveBytes(sourceId, bytes.length).ok).toBe(true);
      return { requestedUrl: url, finalUrl: url, status: url.includes('csdn.net') ? 'http_error' : 'readable',
        statusCode: url.includes('csdn.net') ? 521 : 200, contentType: 'text/html', bytes,
        receivedBytes: bytes.length, redirectChain: [] };
    }, parse: extractBody,
    extract: async ({ sourceId, passages }) => {
      const passage = passages.find((p) => p.text.includes('parallel threads'))!;
      return { sourceId, status: 'claims', examinedPassageIds: [passage.passageId], gaps: [],
        claims: [{ sourceId, claimId: 'claim', statement: passage.text, relevantAngleIds: ['architecture'],
          evidenceIds: ['evidence'], verification: 'grounded' }],
        evidence: [{ sourceId, claimId: 'claim', evidenceId: 'evidence', passageId: passage.passageId,
          quote: 'parallel threads', relation: 'supports', verification: 'grounded' }] };
    }, resolveModel: async () => ({ providerId: 'fixture', modelId: 'fixture', runtimeRevision: 1 }),
    adapter: { currentRevision: () => 1, complete: async () => ({ text: '', stopReason: 'stop' }) },
    onUpdate: () => {}, browserReader: options.browser, ...options.deps };
  const service = new WebResearchTaskService(deps);
  return { task, source, store, deps, service,
    run: async () => { await service.whenIdle(task.threadId, task.researchRunId); return (await store.listSources(task))[0]; } };
}

describe('durable browser task scheduling', () => {
  it.each(['https://www.infoq.cn/article/architecture', 'https://blog.csdn.net/author/article/details/123'])(
    'recovers a shell/521 into grounded evidence on the same source: %s', async (url) => {
      let attemptId = '';
      const h = await harness({ url, browser: reader(async (input) => {
        attemptId = input.attemptId;
        await input.beforeNavigate();
        expect(await input.onDocument(doc(url))).toBe('accepted');
        return { status: 'readable', document: (({ html: _html, ...facts }) => facts)(doc(url)), leaseId: 'live-lease' };
      }) });
      const saved = await h.run();
      expect(saved.status).toBe('completed');
      expect(saved.sourceId).toBe(h.source.sourceId);
      expect(saved.statusCode).toBe(url.includes('csdn') ? 521 : 200);
      expect(saved.browser!.attempts.at(-1)!.mainStatusCode).toBe(200);
      expect(saved.retrieval).toEqual({ method: 'browser', attemptId });
      expect(saved.completeness).toBe('unknown');
      expect(saved.extraction!.evidence[0].verification).toBe('grounded');
      expect(evidencePublicationState(saved, saved.extraction!.evidence[0]).publishable).toBe(true);
      const task = await h.store.loadTask(h.task.threadId, h.task.researchRunId);
      expect(task.usage.fetchesDispatched).toBe(2);
      expect(task.usage.receivedBytes).toBe(56);
      expect(task.browserDomBytes).toBe(Buffer.byteLength(html));
    });

  it('reserves durably before navigation and prevents navigation after a reservation write fails', async () => {
    let opened = 0;
    const setup = async (fail: boolean) => {
      const h = await harness();
      const saveTask = h.store.saveTask.bind(h.store);
      vi.spyOn(h.store, 'saveTask').mockImplementation(async (task) => {
        if (fail && task.usage.fetchesDispatched === 2) throw new Error('disk_reservation_failed');
        await saveTask(task);
      });
      h.deps.browserReader = reader(async (input) => {
        await input.beforeNavigate();
        expect((await h.store.loadTask(h.task.threadId, h.task.researchRunId)).usage.fetchesDispatched).toBe(2);
        expect((await h.store.listSources(h.task))[0].browser!.attempts.at(-1)!.navigationReserved).toBe(true);
        opened++;
        return { status: 'waiting_user', reason: 'browser_read_timeout' };
      });
      return h;
    };
    const good = await setup(false); await good.run(); expect(opened).toBe(1);
    const bad = await setup(true); await expect(bad.run()).rejects.toThrow('disk_reservation_failed'); expect(opened).toBe(1);
  });

  it('charges rejected DOM snapshots separately and leaves waiting sources unprocessed', async () => {
    const empty = '<html><body></body></html>';
    const h = await harness({ browser: reader(async (input) => {
      await input.beforeNavigate();
      expect(await input.onDocument(doc(input.requestedUrl, empty))).toBe('continue');
      expect(await input.onDocument(doc(input.requestedUrl, html))).toBe('accepted');
      return { status: 'waiting_user', reason: 'user_navigated', leaseId: 'lease' };
    }) });
    const saved = await h.run();
    expect(saved.status).toBe('waiting_user');
    expect(saved.browserDomBytes).toBe(Buffer.byteLength(empty + html));
    const state = await h.service.get(h.task.threadId, h.task.researchRunId);
    expect(state.browserDomBytes).toBe(Buffer.byteLength(empty + html));
    expect(state.counts).toMatchObject({ waiting_user: 1, failed: 0, processed: 0 });
    expect(state.sites[0].processed).toBe(0);
  });

  it.each([{ maxBytesPerSource: 100, maxTotalBytes: 500, status: 'failed', reason: 'browser_source_dom_limit' },
    { maxBytesPerSource: 500, maxTotalBytes: 100, status: 'browser_queued', reason: 'browser_total_dom_limit' }])(
    'classifies oversize without charging metadata ($reason)', async ({ status, reason, ...budget }) => {
      const h = await harness({ budget, browser: reader(async (input) => {
        await input.beforeNavigate(); expect(await input.remainingDomBytes()).toBe(100);
        expect(await input.onDocument(doc(input.requestedUrl, '<html><body></body></html>'))).toBe('continue');
        expect(await input.remainingDomBytes()).toBe(74);
        return { status: 'budget_blocked', reason: 'browser_dom_budget' };
      }) });
      const saved = await h.run();
      expect(saved).toMatchObject({ status, reason });
      expect(saved.browserDomBytes).toBe(26);
      expect((await h.service.get(h.task.threadId, h.task.researchRunId)).status).toBe(status === 'failed' ? 'running' : 'paused');
    });
  it('keeps a browser source queued until the reader announces acquisition of the global slot', async () => {
    let queued!: () => void, begin!: () => void;
    const started = new Promise<void>((resolve) => { queued = resolve; });
    const gate = new Promise<void>((resolve) => { begin = resolve; });
    const h = await harness({ browser: reader(async (input) => {
      queued(); await gate; await input.onStarted!();
      const source = (await h.store.listSources(h.task))[0];
      expect(source.status).toBe('browser_reading');
      expect(source.browser!.attempts.at(-1)!.phase).toBe('reading');
      await input.beforeNavigate(); return { status: 'waiting_user', reason: 'verification_widget' };
    }) });
    const running = h.run(); await started;
    expect((await h.service.get(h.task.threadId, h.task.researchRunId)).counts.browser_queued).toBe(1);
    begin(); expect((await running).status).toBe('waiting_user');
  });

  it('lets another HTTP source finish while browser work is in flight with one HTTP worker', async () => {
    let finishBrowser!: () => void, finishedHttp!: () => void;
    const browserGate = new Promise<void>((resolve) => { finishBrowser = resolve; });
    const httpDone = new Promise<void>((resolve) => { finishedHttp = resolve; });
    const h = await harness({ budget: { fetchConcurrency: 1 }, browser: reader(async (input) => {
      await input.onStarted?.(); await input.beforeNavigate(); await browserGate;
      return { status: 'waiting_user', reason: 'browser_read_timeout' };
    }) });
    const fetch = h.deps.fetch, extract = h.deps.extract!;
    h.deps.fetch = async (input) => {
      if (!input.url.includes('http.example')) return fetch(input);
      const bytes = Buffer.from(html); expect(input.budget.reserveBytes(input.sourceId, bytes.length).ok).toBe(true);
      return { requestedUrl: input.url, finalUrl: input.url, status: 'readable', bytes,
        receivedBytes: bytes.length, redirectChain: [], contentType: 'text/html' };
    };
    h.deps.extract = async (input) => { const result = await extract(input); finishedHttp(); return result; };
    await h.store.saveSource(h.task, { ...h.source, sourceId: randomUUID(), requestedUrl: 'https://http.example/article',
      createdAt: '2999-01-01T00:00:00.000Z' });
    const running = h.run(); await httpDone;
    expect((await h.service.get(h.task.threadId, h.task.researchRunId)).counts.browser_reading).toBe(1);
    finishBrowser(); await running;
    expect((await h.service.get(h.task.threadId, h.task.researchRunId)).counts).toMatchObject({ completed: 1, waiting_user: 1, processed: 1 });
  });

  it('does not refund a persisted navigation reservation when its source write fails', async () => {
    let navigations = 0;
    const h = await harness({ browser: reader(async (input) => {
      await input.beforeNavigate(); navigations++; return { status: 'waiting_user', reason: 'browser_read_timeout' };
    }) });
    await h.run(); expect(navigations).toBe(1);
    const broken = await harness({ browser: h.deps.browserReader });
    const saveSource = broken.store.saveSource.bind(broken.store);
    vi.spyOn(broken.store, 'saveSource').mockImplementation(async (task, source) => {
      if (source.browser?.attempts.some((attempt) => attempt.navigationReserved)) throw new Error('source_disk_failure');
      await saveSource(task, source);
    });
    await expect(broken.run()).rejects.toThrow('source_disk_failure'); expect(navigations).toBe(1);
    const recovered = new WebResearchTaskService({ ...broken.deps, store: new TaskStore(roots.at(-1)!) });
    const snapshot = await recovered.get(broken.task.threadId, broken.task.researchRunId);
    expect(snapshot.usage.fetchesDispatched).toBe(2);
    await recovered.whenIdle(broken.task.threadId, broken.task.researchRunId);
    expect(navigations).toBe(1);
  });

  it('recovers DOM from the source after its aggregate write fails, without another automatic read', async () => {
    let reads = 0;
    const h = await harness({ browser: reader(async (input) => {
      reads++; await input.beforeNavigate(); await input.onDocument(doc(input.requestedUrl));
      return { status: 'waiting_user', reason: 'browser_read_timeout' };
    }) });
    const saveTask = h.store.saveTask.bind(h.store);
    vi.spyOn(h.store, 'saveTask').mockImplementation(async (task) => {
      if (task.browserDomBytes) throw new Error('aggregate_disk_failure'); await saveTask(task);
    });
    await expect(h.run()).rejects.toThrow('aggregate_disk_failure');
    const persisted = (await h.store.listSources(h.task))[0];
    expect(persisted.browserDomBytes).toBe(Buffer.byteLength(html));
    expect((await h.store.loadTask(h.task.threadId, h.task.researchRunId)).browserDomBytes ?? 0).toBe(0);
    const recovered = new WebResearchTaskService({ ...h.deps, store: new TaskStore(roots.at(-1)!) });
    expect((await recovered.get(h.task.threadId, h.task.researchRunId)).browserDomBytes).toBe(Buffer.byteLength(html));
    await recovered.whenIdle(h.task.threadId, h.task.researchRunId);
    expect(reads).toBe(1);
  });

  it('preserves valid old evidence until a candidate is committed, then clears it before extracting', async () => {
    let releaseCandidate!: () => void, candidateReady!: () => void;
    const gate = new Promise<void>((resolve) => { releaseCandidate = resolve; });
    const ready = new Promise<void>((resolve) => { candidateReady = resolve; });
    const h = await harness({ browser: reader(async (input) => {
      await input.beforeNavigate(); const document = doc(input.requestedUrl);
      expect(await input.onDocument(document)).toBe('accepted'); candidateReady(); await gate;
      const { html: _html, ...facts } = document;
      return { status: 'readable', document: facts };
    }) });
    h.source.passages = [{ sourceId: h.source.sourceId, passageId: 'old', ordinal: 1, text: 'Old grounded body' }];
    h.source.contentHash = 'old-hash';
    h.source.extraction = { sourceId: h.source.sourceId, status: 'claims', claims: [], gaps: [], examinedPassageIds: ['old'],
      evidence: [{ sourceId: h.source.sourceId, evidenceId: 'old-evidence', claimId: 'old-claim', passageId: 'old',
        quote: 'Old grounded body', relation: 'supports', verification: 'grounded' }] };
    await h.store.saveSource(h.task, h.source);
    const originalExtract = h.deps.extract!;
    h.deps.extract = async (input) => {
      const saved = (await h.store.listSources(h.task))[0];
      expect(saved.extraction).toBeUndefined();
      expect(saved.passages.some((p) => p.text.includes('parallel threads'))).toBe(true);
      return originalExtract(input);
    };
    const running = h.run(); await ready;
    const waiting = (await h.store.listSources(h.task))[0];
    expect(waiting.contentHash).toBe('old-hash'); expect(waiting.extraction!.evidence[0].evidenceId).toBe('old-evidence');
    releaseCandidate(); expect((await running).extraction!.evidence[0].evidenceId).toBe('evidence');
  });

  it('does not recursively auto-read a browser body with another grounded barrier', async () => {
    let reads = 0;
    const h = await harness({ browser: reader(async (input) => {
      reads++; await input.beforeNavigate(); const document = doc(input.requestedUrl);
      await input.onDocument(document); const { html: _html, ...facts } = document;
      return { status: 'readable', document: facts };
    }), deps: { extract: async ({ sourceId, passages }) => ({ sourceId, status: 'incomplete',
      reason: 'needs_browser', claims: [], evidence: [], gaps: [], examinedPassageIds: [passages[0].passageId],
      barriers: [{ passageId: passages[0].passageId, quote: passages[0].text }] }) } });
    expect((await h.run()).status).toBe('waiting_user');
    expect(reads).toBe(1);
    await h.service.whenIdle(h.task.threadId, h.task.researchRunId); expect(reads).toBe(1);
  });

  it('applies exact runtime lease notifications after waiting and ignores foreign or stale leases', async () => {
    let notify!: (event: BrowserLeaseUnavailable) => void;
    const browser = reader(async (input) => {
      await input.onStarted?.(); await input.beforeNavigate();
      return { status: 'waiting_user', reason: 'verification_widget', leaseId: 'current-lease' };
    });
    browser.onLeaseUnavailable = (listener) => { notify = listener; return () => {}; };
    const h = await harness({ browser }); const saved = await h.run();
    const event: BrowserLeaseUnavailable = { threadId: h.task.threadId, researchRunId: h.task.researchRunId,
      sourceId: h.source.sourceId, attemptId: saved.browser!.attempts.at(-1)!.attemptId,
      leaseId: 'current-lease', reason: 'tab_closed' };
    notify(event);
    await vi.waitFor(async () => expect((await h.store.listSources(h.task))[0].reason).toBe('tab_closed'));
    for (const change of [{ leaseId: 'stale' }, { attemptId: 'old' }, { sourceId: 'foreign' }, { threadId: 'foreign' }]) {
      notify({ ...event, ...change, reason: 'must_not_replace' });
    }
    await h.service.whenIdle(h.task.threadId, h.task.researchRunId);
    expect((await h.store.listSources(h.task))[0].reason).toBe('tab_closed');
    expect(JSON.stringify((await h.store.listSources(h.task))[0])).not.toContain('current-lease');
  });

  it('accepts the same document facts independent of property insertion order', async () => {
    const h = await harness({ browser: reader(async (input) => {
      await input.beforeNavigate(); const document = doc(input.requestedUrl); await input.onDocument(document);
      return { status: 'readable', document: { mainStatusCode: 200, utf8Bytes: document.utf8Bytes,
        rootRule: document.rootRule, identity: { navigationSequence: 7, routeRevision: 2, documentEpoch: 3 }, url: document.url } };
    }) });
    expect((await h.run()).status).toBe('completed');
  });

  it('settles a model failure after accepted browser body without stranding extracting work', async () => {
    const h = await harness({ browser: reader(async (input) => {
      await input.beforeNavigate(); const document = doc(input.requestedUrl); await input.onDocument(document);
      const { html: _html, ...facts } = document; return { status: 'readable', document: facts };
    }), deps: { extract: async () => { throw new Error('model_transport_failed'); } } });
    expect(await h.run()).toMatchObject({ status: 'failed', reason: 'model_transport_failed', retrieval: { method: 'browser' } });
  });

  it('never commits a late pre-pause body after a new runtime controller is installed', async () => {
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const admitted = new Promise<void>((resolve) => { ready = resolve; });
    const h = await harness({ browser: reader(async (input) => {
      await input.onStarted?.(); await input.beforeNavigate(); const document = doc(input.requestedUrl);
      expect(await input.onDocument(document)).toBe('accepted'); ready(); await gate;
      const { html: _html, ...facts } = document; return { status: 'readable', document: facts };
    }) });
    const running = h.run(); await admitted;
    await h.service.control(h.task.threadId, h.task.researchRunId, 'pause');
    await h.service.control(h.task.threadId, h.task.researchRunId, 'resume');
    release(); const saved = await running;
    expect(saved.status).toBe('waiting_user');
    expect(saved.browser!.attempts.at(-1)!.phase).toBe('interrupted');
  });

  it('pauses on a rejected body write and keeps the old evidence available in memory and on disk', async () => {
    let extracted = 0;
    const successful = await harness({ browser: reader(async (input) => {
      await input.beforeNavigate(); const document = doc(input.requestedUrl); await input.onDocument(document);
      const { html: _html, ...facts } = document; return { status: 'readable', document: facts };
    }) });
    const extract = successful.deps.extract!;
    const countedExtract: NonNullable<TaskDeps['extract']> = async (input) => { extracted++; return extract(input); };
    successful.deps.extract = countedExtract;
    expect((await successful.run()).status).toBe('completed');
    expect(extracted).toBe(1);
    const h = await harness({ browser: reader(async (input) => {
      await input.beforeNavigate(); const document = doc(input.requestedUrl); await input.onDocument(document);
      const { html: _html, ...facts } = document; return { status: 'readable', document: facts };
    }) });
    h.source.passages = [{ sourceId: h.source.sourceId, passageId: 'old', ordinal: 1, text: 'Old grounded body' }];
    h.source.contentHash = 'old-hash';
    h.source.extraction = { sourceId: h.source.sourceId, status: 'claims', claims: [], gaps: [], examinedPassageIds: ['old'],
      evidence: [{ sourceId: h.source.sourceId, evidenceId: 'old-evidence', claimId: 'old-claim', passageId: 'old',
        quote: 'Old grounded body', relation: 'supports', verification: 'grounded' }] };
    await h.store.saveSource(h.task, h.source);
    const savedOriginal = (await h.store.listSources(h.task))[0];
    expect(savedOriginal.extraction!.evidence[0].quote).toBe('Old grounded body');
    const save = h.store.saveSource.bind(h.store), failure = new Error('replacement_write_failed');
    vi.spyOn(h.store, 'saveSource').mockImplementation(async (task, source) => {
      if (source.retrieval?.method === 'browser') throw failure;
      await save(task, source);
    });
    h.deps.extract = countedExtract;
    const saved = await h.run();
    expect((await h.service.get(h.task.threadId, h.task.researchRunId)).status).toBe('paused');
    expect(saved).toMatchObject({ status: 'waiting_user', contentHash: 'old-hash' });
    expect(saved.browser!.attempts.at(-1)!.phase).toBe('interrupted');
    const inspected = await h.service.inspect(h.task.threadId, h.task.researchRunId,
      { view: 'evidence', evidenceIds: ['old-evidence'] });
    expect(inspected.items[0]).toMatchObject({ quote: 'Old grounded body', excerpt: 'Old grounded body' });
    expect(extracted).toBe(1);
  });

  it('settles other queued browser workers as queued when one exhausts the task DOM budget', async () => {
    let paused!: () => void;
    const pause = new Promise<void>((resolve) => { paused = resolve; });
    let first = true;
    const h = await harness({ budget: { maxTotalBytes: 120, maxBytesPerSource: 500 },
      deps: { onUpdate: (snapshot) => { if (snapshot.statusReason === 'browser_total_dom_limit') paused(); } },
      browser: reader(async (input) => {
        if (first) { first = false; await input.onStarted?.(); await input.beforeNavigate();
          return { status: 'budget_blocked', reason: 'browser_dom_budget' }; }
        await pause; await input.onStarted?.();
        return { status: 'waiting_user', reason: 'should_not_start' };
      }) });
    await h.store.saveSource(h.task, { ...h.source, sourceId: randomUUID(), requestedUrl: 'https://www.infoq.cn/article/second' });
    await h.run();
    const snapshot = await h.service.get(h.task.threadId, h.task.researchRunId);
    expect(snapshot).toMatchObject({ status: 'paused', counts: { browser_queued: 2, browser_reading: 0, failed: 0 } });
  });

  it('rejects stale candidates after parsing and before any body replacement', async () => {
    let parseStarted!: () => void, finishParse!: () => void;
    const started = new Promise<void>((resolve) => { parseStarted = resolve; });
    const parseGate = new Promise<void>((resolve) => { finishParse = resolve; });
    let accepted = '';
    const h = await harness({ browser: reader(async (input) => {
      await input.beforeNavigate(); const document = doc(input.requestedUrl);
      accepted = await input.onDocument(document);
      const { html: _html, ...facts } = document; return { status: 'readable', document: facts };
    }) });
    h.deps.parse = async (input) => {
      if (new TextDecoder().decode(input.bytes).includes('parallel threads')) { parseStarted(); await parseGate; }
      return extractBody(input);
    };
    const running = h.run(); await started;
    await h.service.control(h.task.threadId, h.task.researchRunId, 'pause');
    finishParse(); const saved = await running;
    expect(accepted).toBe('continue');
    expect(saved.status).toBe('waiting_user');
  });

  it('recovers a paused in-flight browser attempt as interrupted without replaying navigation', async () => {
    const h = await harness();
    h.task.status = 'paused'; h.task.usage.fetchesDispatched = 9;
    h.source.status = 'browser_reading';
    h.source.browser = { trigger: 'body_needs_browser', automaticAttemptUsed: true, attempts: [{
      attemptId: 'interrupted-attempt', sequence: 1, initiatedBy: 'automatic', phase: 'reading',
      startedAt: h.task.createdAt, requestedUrl: h.source.requestedUrl, navigationMode: 'navigate',
      navigationReserved: true, domBytes: 0,
    }] };
    await h.store.saveTask(h.task); await h.store.saveSource(h.task, h.source);
    const saved = await h.run();
    expect(saved).toMatchObject({ status: 'waiting_user', reason: 'interrupted' });
    expect(saved.browser!.attempts[0].phase).toBe('interrupted');
    expect((await h.service.get(h.task.threadId, h.task.researchRunId)).usage.fetchesDispatched).toBe(9);
  });

  it('pauses at the dispatch cap and settles whenIdle without performing a browser navigation', async () => {
    let navigated = 0;
    const browser = reader(async (input) => { await input.beforeNavigate(); navigated++;
      return { status: 'waiting_user', reason: 'browser_read_timeout' }; });
    const allowed = await harness({ browser }); await allowed.run(); expect(navigated).toBe(1);
    const denied = await harness({ budget: { maxFetches: 1 }, browser });
    expect(await denied.run()).toMatchObject({ status: 'browser_queued', reason: 'fetch_limit' });
    expect((await denied.service.get(denied.task.threadId, denied.task.researchRunId)).status).toBe('paused');
    await denied.service.whenIdle(denied.task.threadId, denied.task.researchRunId);
    expect(navigated).toBe(1);
  });

  it('preserves the original storage cause when a lease notification cannot be saved', async () => {
    let notify!: (event: BrowserLeaseUnavailable) => void;
    const browser = reader(async (input) => {
      await input.beforeNavigate(); return { status: 'waiting_user', reason: 'verification_widget', leaseId: 'live' };
    });
    browser.onLeaseUnavailable = (listener) => { notify = listener; return () => {}; };
    const h = await harness({ browser }); const saved = await h.run();
    const event = { threadId: h.task.threadId, researchRunId: h.task.researchRunId,
      sourceId: h.source.sourceId, attemptId: saved.browser!.attempts[0].attemptId, leaseId: 'live', reason: 'tab_closed' };
    notify(event);
    await vi.waitFor(async () => expect((await h.store.listSources(h.task))[0].reason).toBe('tab_closed'));
    const primary = new Error('lease_write_failed');
    vi.spyOn(h.store, 'saveSource').mockRejectedValue(primary);
    notify({ ...event, reason: 'renderer_crashed' });
    await vi.waitFor(async () => expect((await h.service.get(h.task.threadId, h.task.researchRunId)).statusReason).toBe('storage_error'));
    await expect(h.service.whenIdle(h.task.threadId, h.task.researchRunId)).rejects.toBe(primary);
  });

  it('keeps model-reservation storage failure distinct from the extractor model_error result', async () => {
    let calls = 0;
    const browser = reader(async (input) => {
      await input.beforeNavigate(); const document = doc(input.requestedUrl); await input.onDocument(document);
      const { html: _html, ...facts } = document; return { status: 'readable', document: facts };
    });
    const adapter: TaskDeps['adapter'] = { currentRevision: () => 1, complete: async () => {
      calls++; return { text: JSON.stringify({ status: 'irrelevant', claims: [], barriers: [], gaps: [] }), stopReason: 'stop' };
    } };
    const good = await harness({ browser, deps: { extract: undefined, adapter } }); await good.run(); expect(calls).toBe(1);
    const bad = await harness({ browser, deps: { extract: undefined, adapter } });
    const save = bad.store.saveTask.bind(bad.store), primary = new Error('model_reservation_write_failed');
    let failOnce = true;
    vi.spyOn(bad.store, 'saveTask').mockImplementation(async (task) => {
      if (task.usage.modelCalls > 0 && failOnce) { failOnce = false; throw primary; }
      await save(task);
    });
    const saved = await bad.run();
    expect((await bad.service.get(bad.task.threadId, bad.task.researchRunId)).statusReason).toBe('storage_error');
    expect(saved).toMatchObject({ status: 'waiting_user' });
    expect(saved.browser!.attempts[0]).toMatchObject({ phase: 'interrupted', reason: primary.message });
    expect(calls).toBe(1);
  });

  it.each(['http_fetch', 'http_parse', 'browser_model'] as const)(
    'settles an accepted body across a concurrent browser budget pause and resumes without refetch: %s', async (stage) => {
      let entered!: () => void, release!: () => void, paused!: () => void;
      const atStage = new Promise<void>((resolve) => { entered = resolve; });
      const continueStage = new Promise<void>((resolve) => { release = resolve; });
      const taskPaused = new Promise<void>((resolve) => { paused = resolve; });
      const targetUrl = stage === 'browser_model' ? 'https://www.infoq.cn/article/target' : 'https://http.example/target';
      const blockerUrl = 'https://www.infoq.cn/article/blocker';
      const h = await harness({ url: targetUrl, budget: { fetchConcurrency: 2, maxTotalBytes: 1000, maxBytesPerSource: 2000 },
        deps: { onUpdate: (snapshot) => { if (snapshot.statusReason === 'browser_total_dom_limit') paused(); } },
        browser: reader(async (input) => {
          await input.onStarted?.(); await input.beforeNavigate();
          if (input.requestedUrl === blockerUrl) {
            await atStage; return { status: 'budget_blocked', reason: 'browser_dom_budget' };
          }
          const document = doc(input.requestedUrl); await input.onDocument(document);
          const { html: _html, ...facts } = document; return { status: 'readable', document: facts };
        }) });
      const fetch = h.deps.fetch, parse = h.deps.parse, resolveModel = h.deps.resolveModel, extract = h.deps.extract!;
      const fetchedIds: string[] = [], extractedIds: string[] = [];
      h.deps.fetch = async (input) => {
        fetchedIds.push(input.sourceId);
        if (input.url !== targetUrl || stage === 'browser_model') return fetch(input);
        if (stage === 'http_fetch') { entered(); await continueStage; }
        const bytes = Buffer.from(html); expect(input.budget.reserveBytes(input.sourceId, bytes.length).ok).toBe(true);
        return { requestedUrl: input.url, finalUrl: input.url, status: 'readable', bytes,
          receivedBytes: bytes.length, redirectChain: [], contentType: 'text/html' };
      };
      h.deps.parse = async (input) => {
        if (input.sourceId === h.source.sourceId && stage === 'http_parse') { entered(); await continueStage; }
        return parse(input);
      };
      h.deps.resolveModel = async (threadId) => {
        if (stage === 'browser_model') { entered(); await continueStage; }
        return resolveModel(threadId);
      };
      h.deps.extract = async (input) => { extractedIds.push(input.sourceId); return extract(input); };
      await h.store.saveSource(h.task, { ...h.source, sourceId: randomUUID(), requestedUrl: blockerUrl });
      const running = h.run(); await taskPaused; release(); await running;
      const beforeResume = (await h.store.listSources(h.task)).find((source) => source.sourceId === h.source.sourceId)!;
      const pausedExtractions = [...extractedIds];
      expect(beforeResume).toMatchObject({ status: 'queued', pendingReanalysis: true });
      expect(beforeResume.passages.some((passage) => passage.text.includes('parallel threads'))).toBe(true);
      const pausedSnapshot = await h.service.get(h.task.threadId, h.task.researchRunId);
      await h.service.control(h.task.threadId, h.task.researchRunId, 'resume');
      await h.service.whenIdle(h.task.threadId, h.task.researchRunId);
      const resumed = (await h.store.listSources(h.task)).find((source) => source.sourceId === h.source.sourceId)!;
      expect(resumed).toMatchObject({ status: 'completed', contentHash: beforeResume.contentHash, retrieval: beforeResume.retrieval });
      expect(extractedIds).toEqual([h.source.sourceId]);
      expect(pausedExtractions).toHaveLength(0);
      expect(fetchedIds.filter((sourceId) => sourceId === h.source.sourceId)).toHaveLength(1);
      expect(pausedSnapshot.counts).toMatchObject({ fetching: 0, extracting: 0 });
    });

});
