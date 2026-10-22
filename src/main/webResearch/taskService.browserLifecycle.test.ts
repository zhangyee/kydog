import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebResearchTaskService, type TaskDeps } from './taskService';
import { TaskStore } from './taskStore';
import { DEFAULT_WEB_RESEARCH_TASK_BUDGET, type WebResearchTaskRecord, type WebResearchTaskSource } from '../../shared/webResearchTask';
import type { BrowserReader, BrowserReadInput } from './browserReadTypes';
import { createBrowserReader } from './browserReader';
import type { BrowserService } from '../browser/browserService';
import { extractBody } from './extractBody';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const html = '<html><body><article><p>Parallel threads preserve isolated evidence.</p></article></body></html>';
async function readable(input: BrowserReadInput) {
  await input.onStarted?.();
  if (input.mode === 'navigate') await input.beforeNavigate();
  const document = { url: input.requestedUrl, identity: { documentEpoch: 2, routeRevision: 3, navigationSequence: 4 },
    rootRule: 'article', utf8Bytes: Buffer.byteLength(html), mainStatusCode: 200 };
  await input.onDocument({ ...document, html });
  return { status: 'readable' as const, document, leaseId: 'lease' };
}
async function harness(status: WebResearchTaskSource['status'] = 'waiting_user', taskStatus: WebResearchTaskRecord['status'] = 'running') {
  const root = await mkdtemp(path.join(tmpdir(), 'kydog-lifecycle-')); roots.push(root);
  const store = new TaskStore(root), now = new Date().toISOString();
  const task: WebResearchTaskRecord = { threadId: randomUUID(), researchRunId: randomUUID(), createdByRunId: randomUUID(),
    projectRoot: root, originalQuestion: 'Evidence', createdAt: now, updatedAt: now, revision: 1, status: taskStatus,
    angles: [{ id: 'a', label: 'Evidence', query: 'evidence' }], attempts: [], observationIds: [], discoveryCount: 0,
    budget: { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET }, usage: { candidates: 1, fetchesDispatched: 2, receivedBytes: 20, modelCalls: 0 } };
  const source: WebResearchTaskSource = { sourceId: randomUUID(), requestedUrl: 'https://www.infoq.cn/article/one',
    finalUrl: 'https://www.infoq.cn/article/one', status, reason: 'needs_browser', createdAt: now, updatedAt: now, discoveries: [], passages: [] };
  await store.createTask(task); await store.saveSource(task, source);
  const reader: BrowserReader = { read: vi.fn(readable), currentTab: () => undefined,
    openForUser: vi.fn(async input => { await input.beforeNavigate(); return { tabId: 'tab', leaseId: 'lease' }; }),
    release: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
  const deps: TaskDeps = { store, browserReader: reader, parse: extractBody,
    fetch: vi.fn(async () => { throw new Error('unexpected HTTP'); }),
    resolveModel: async () => ({ providerId: 'fixture', modelId: 'fixture', runtimeRevision: 1 }),
    adapter: { currentRevision: () => 1, complete: async () => ({ text: '', stopReason: 'stop' }) },
    extract: async ({ sourceId, passages }) => ({ sourceId, status: 'claims', examinedPassageIds: [passages[0].passageId], gaps: [],
      claims: [{ sourceId, claimId: 'c', statement: 'Parallel threads', relevantAngleIds: ['a'], evidenceIds: ['e'], verification: 'grounded' }],
      evidence: [{ sourceId, claimId: 'c', evidenceId: 'e', passageId: passages[0].passageId, quote: 'Parallel threads', relation: 'supports', verification: 'grounded' }] }),
    onUpdate: () => {} };
  const service = new WebResearchTaskService(deps);
  const key = { threadId: task.threadId, researchRunId: task.researchRunId, sourceId: source.sourceId };
  const saved = () => store.loadSource(task, source.sourceId);
  const idle = () => service.whenIdle(task.threadId, task.researchRunId);
  return { root, store, task, source, reader, deps, service, key, saved, idle };
}

describe('browser task lifecycle', () => {
  it('retries once for a shared expectedAttemptId and rejects a late result', async () => {
    const h = await harness();
    const action = { ...h.key, expectedAttemptId: null };
    await Promise.all([h.service.retrySource(action), h.service.retrySource(action)]); await h.idle();
    expect(h.reader.read).toHaveBeenCalledTimes(1);
    const oldInput = vi.mocked(h.reader.read).mock.calls[0][0];
    const completed = await h.saved();
    expect(completed.status).toBe('completed'); expect(completed.browser!.attempts).toHaveLength(1);
    expect(completed.extraction!.evidence[0].quote).toBe('Parallel threads');
    const before = await h.service.get(h.task.threadId, h.task.researchRunId);
    await h.service.retrySource(action);
    const late = { html: '<article>Outdated body</article>', url: oldInput.requestedUrl,
      identity: { documentEpoch: 1, routeRevision: 0, navigationSequence: 1 }, rootRule: 'article', utf8Bytes: 32 };
    expect(await oldInput.onDocument(late)).toBe('continue'); await h.idle();
    expect(await h.saved()).toEqual(completed);
    expect((await h.service.get(h.task.threadId, h.task.researchRunId)).revision).toBe(before.revision);
  });

  it('opens only the owned source, without accepting body or creating an attempt', async () => {
    const h = await harness();
    const before = await h.saved();
    const result = await h.service.openSource(h.key);
    expect(result).toMatchObject({ tabId: 'tab', expectedAttemptId: null, snapshot: { counts: { waiting_user: 1 } } });
    expect(await h.saved()).toEqual(before);
    expect((await h.service.get(h.key.threadId, h.key.researchRunId)).usage.fetchesDispatched).toBe(3);
    await expect(h.service.openSource({ ...h.key, sourceId: randomUUID() })).rejects.toThrow('source');
    expect(h.reader.openForUser).toHaveBeenCalledTimes(1);
  });

  it.each(['paused', 'completed', 'cancelled'] as const)('rejects retry of a %s task without scheduling another source', async status => {
    const h = await harness();
    await h.service.retrySource({ ...h.key, expectedAttemptId: null }); await h.idle();
    expect(h.reader.read).toHaveBeenCalledTimes(1);
    const blocked = await harness('waiting_user', status); blocked.deps.browserReader = h.reader;
    await expect(blocked.service.retrySource({ ...blocked.key, expectedAttemptId: null })).rejects.toThrow();
    expect(h.reader.read).toHaveBeenCalledTimes(1); expect((await blocked.saved()).status).toBe('waiting_user');
  });

  it('recovers interrupted durable attempts only on explicit resume, keeping reserved budgets', async () => {
    const h = await harness('browser_reading');
    h.source.browser = { trigger: 'body_needs_browser', automaticAttemptUsed: true, attempts: [{ attemptId: 'old', sequence: 1,
      initiatedBy: 'automatic', phase: 'reading', startedAt: h.source.createdAt, requestedUrl: h.source.requestedUrl,
      navigationMode: 'navigate', navigationReserved: true, domBytes: 17 }] };
    h.source.browserDomBytes = 17; await h.store.saveSource(h.task, h.source);
    await h.idle(); expect(await h.saved()).toMatchObject({ status: 'waiting_user', reason: 'interrupted' });
    await h.service.control(h.key.threadId, h.key.researchRunId, 'resume'); await h.idle();
    expect(h.reader.read).toHaveBeenCalledTimes(1);
    const saved = await h.saved(); expect(saved.status).toBe('completed');
    expect(saved.browser!.attempts.map(a => [a.initiatedBy, a.phase])).toEqual([['automatic', 'interrupted'], ['resume', 'readable']]);
    expect((await h.service.get(h.key.threadId, h.key.researchRunId)).usage.fetchesDispatched).toBe(3);
    expect(saved.browserDomBytes).toBe(17 + Buffer.byteLength(html));
  });

  it.each(['completed', 'cancelled'] as const)('does not repair or rewrite historical %s files', async status => {
    const control = await harness('browser_reading'); await control.idle();
    expect((await control.saved()).status).toBe('waiting_user');
    const h = await harness('browser_reading', status);
    h.task.usage.candidates = 7; h.task.browserDomBytes = 1; await h.store.saveTask(h.task);
    h.source.browserDomBytes = 12; await h.store.saveSource(h.task, h.source);
    const file = path.join(h.root, h.key.threadId, h.key.researchRunId, 'task.json');
    const before = await readFile(file, 'utf8'); await h.idle();
    expect(await readFile(file, 'utf8')).toBe(before); expect(await h.saved()).toEqual(h.source);
  });

  it.each(['pause', 'cancel', 'dispose', 'shutdown'] as const)('revokes late DOM and preserves evidence on %s', async action => {
    const h = await harness(); await h.service.retrySource({ ...h.key, expectedAttemptId: null }); await h.idle();
    const completed = await h.saved(); expect(completed.status).toBe('completed');
    // Keep the valid evidence while a newer reading intent is in flight.
    const second = { ...completed, sourceId: randomUUID(), requestedUrl: 'https://www.infoq.cn/article/two', status: 'waiting_user' as const,
      passages: [], extraction: undefined, contentHash: undefined, browser: undefined, reason: 'needs_browser' };
    await h.store.saveSource(h.task, second);
    const service = new WebResearchTaskService(h.deps);
    const entered = deferred(), gate = deferred(); let input!: BrowserReadInput;
    h.reader.read = vi.fn(async value => { input = value; await value.onStarted?.(); entered.resolve(); await gate.promise; return readable(value); });
    await service.retrySource({ ...h.key, sourceId: second.sourceId, expectedAttemptId: null }); await entered.promise;
    const stopping = action === 'dispose' ? service.disposeThread(h.key.threadId) : action === 'shutdown' ? service.shutdown()
      : service.control(h.key.threadId, h.key.researchRunId, action);
    // async control has a runtime lookup; disposal/shutdown must abort before returning.
    if (action === 'dispose' || action === 'shutdown') expect(input.signal.aborted).toBe(true);
    gate.resolve(); await stopping;
    expect(await h.saved()).toEqual(completed);
    const stopped = await h.store.loadSource(h.task, second.sourceId);
    expect(stopped.status).toBe(action === 'cancel' || action === 'dispose' ? 'cancelled' : 'waiting_user');
    expect(stopped.passages).toEqual([]);
  });

  it('rejects an open receipt when a newer source intent has superseded it', async () => {
    const h = await harness(); const started = deferred(), receipt = deferred();
    h.reader.openForUser = async input => { await input.beforeNavigate(); started.resolve(); await receipt.promise; return { tabId: 'old-tab', leaseId: 'old-lease' }; };
    const opening = h.service.openSource(h.key); await started.promise;
    await h.service.retrySource({ ...h.key, expectedAttemptId: null });
    await vi.waitFor(async () => expect((await h.saved()).status).toBe('completed'));
    const saved = await h.saved(); expect(saved.status).toBe('completed');
    const rejected = expect(opening).rejects.toThrow('superseded'); receipt.resolve(); await rejected;
    expect(await h.saved()).toEqual(saved);
  });

  it.each(['browser_queued', 'browser_reading', 'waiting_user'] as const)('requires an unprocessed reason for %s and preserves valid evidence on validation failure', async status => {
    const h = await harness(); await h.service.retrySource({ ...h.key, expectedAttemptId: null }); await h.idle();
    const evidence = await h.saved(); expect(evidence.extraction!.evidence[0].verification).toBe('grounded');
    await h.store.saveSource(h.task, { ...h.source, sourceId: randomUUID(), requestedUrl: 'https://other.example/article', status });
    const service = new WebResearchTaskService(h.deps);
    await expect(service.complete(h.key.threadId, h.key.researchRunId, 'draft')).rejects.toThrow('unprocessedReason');
    const failed = await service.complete(h.key.threadId, h.key.researchRunId, 'Deferred', undefined, 'Deferred');
    expect(failed.completed).toBe(false); expect(await h.saved()).toEqual(evidence);
    const result = await service.complete(h.key.threadId, h.key.researchRunId,
      `[Source](${evidence.finalUrl})〔证据:e〕\nDeferred`, undefined, 'Deferred');
    expect(result.completed).toBe(true);
    expect((await h.store.listSources(h.task)).map(s => s.status).sort()).toEqual(['completed', 'unprocessed']);
  });
  it.each(['pause', 'cancel', 'dispose', 'shutdown'] as const)('rejects a late model result after %s', async action => {
    const h = await harness(); await h.service.retrySource({ ...h.key, expectedAttemptId: null }); await h.idle();
    const good = await h.saved(); expect(good.extraction!.evidence[0].quote).toBe('Parallel threads');
    const next = { ...h.source, sourceId: randomUUID(), requestedUrl: 'https://www.infoq.cn/article/model' };
    await h.store.saveSource(h.task, next);
    const entered = deferred(), gate = deferred(); const extract = h.deps.extract!;
    h.deps.extract = async input => { entered.resolve(); await gate.promise; return extract(input); };
    const service = new WebResearchTaskService(h.deps);
    await service.retrySource({ ...h.key, sourceId: next.sourceId, expectedAttemptId: null }); await entered.promise;
    const stopping = action === 'dispose' ? service.disposeThread(h.key.threadId) : action === 'shutdown' ? service.shutdown()
      : service.control(h.key.threadId, h.key.researchRunId, action);
    gate.resolve(); await stopping;
    if (action === 'pause') await service.whenIdle(h.key.threadId, h.key.researchRunId);
    const stopped = await h.store.loadSource(h.task, next.sourceId);
    expect(stopped.status).toBe(action === 'dispose' || action === 'cancel' ? 'cancelled' : 'queued');
    expect(stopped.extraction).toBeUndefined(); expect(await h.saved()).toEqual(good);
  });

  it('clears the original idle storage error only after explicit recovery and retains reserved usage', async () => {
    const h = await harness();
    const saveSource = h.store.saveSource.bind(h.store); let fail = false;
    const failure = new Error('persistent storage fault');
    vi.spyOn(h.store, 'saveSource').mockImplementation(async (task, source) => {
      if (fail) throw failure;
      return saveSource(task, source);
    });
    h.reader.read = vi.fn(async input => { await input.beforeNavigate(); fail = true; await input.onStarted?.(); return readable(input); });
    await h.service.retrySource({ ...h.key, expectedAttemptId: null });
    await expect(h.idle()).rejects.toBe(failure);
    expect((await h.service.get(h.key.threadId, h.key.researchRunId))).toMatchObject({ status: 'paused', statusReason: 'storage_error', usage: { fetchesDispatched: 3 } });
    fail = false; h.reader.read = vi.fn(readable);
    await h.service.control(h.key.threadId, h.key.researchRunId, 'resume'); await h.idle();
    expect((await h.saved()).status).toBe('completed');
    expect((await h.service.get(h.key.threadId, h.key.researchRunId)).usage.fetchesDispatched).toBe(4);
  });

  it.each([
    { reason: 'script_only_or_no_article', url: 'https://example.org/a', code: 200, count: 1 },
    { reason: 'verification_widget', url: 'https://example.org/a', code: 403, count: 1 },
    { reason: 'http_error', url: 'https://blog.csdn.net/a', code: 521, count: 1 },
    { reason: 'script_only_or_no_articles', url: 'https://example.org/a', code: 200, count: 0 },
    { reason: 'http_error', url: 'https://blog.csdn.net.evil.example/a', code: 521, count: 0 },
  ])('explicitly resumes exact legacy facts: $reason $url', async ({ reason, url, code, count }) => {
    const h = await harness('failed');
    h.source.reason = reason; h.source.finalUrl = url; h.source.statusCode = code; await h.store.saveSource(h.task, h.source);
    await h.idle(); expect((await h.saved()).status).toBe('failed');
    await h.service.control(h.key.threadId, h.key.researchRunId, 'resume'); await h.idle();
    expect((await h.saved()).status).toBe(count ? 'completed' : 'failed');
    // The same reader must demonstrably run; nonmatching records do not add a read.
    const positive = await harness('failed'); positive.deps.browserReader = h.reader;
    await positive.service.control(positive.key.threadId, positive.key.researchRunId, 'resume'); await positive.idle();
    expect(h.reader.read).toHaveBeenCalledTimes(count + 1);
  });

  it('does not automatically retry a previously attempted waiting source on resume', async () => {
    const h = await harness(); h.reader.read = vi.fn(async () => ({ status: 'waiting_user' as const, reason: 'verification_widget', leaseId: 'lease' }));
    await h.service.retrySource({ ...h.key, expectedAttemptId: null }); await h.idle();
    expect(h.reader.read).toHaveBeenCalledTimes(1);
    await h.service.control(h.key.threadId, h.key.researchRunId, 'pause');
    await h.service.control(h.key.threadId, h.key.researchRunId, 'resume'); await h.idle();
    expect(h.reader.read).toHaveBeenCalledTimes(1); expect((await h.saved()).browser!.attempts).toHaveLength(1);
  });

  it.each(['pause', 'cancel', 'dispose', 'shutdown'] as const)('uses the real reader ownership check for %s and kept pages', async action => {
    const exercise = async (keep: boolean) => {
      const h = await harness(); const tabs = new Map<string, string | null>();
      const browser = {
        onTabDestroyed: () => () => {}, onTabUnavailable: () => () => {},
        researchTabStatus: (id: string) => tabs.has(id) ? 'available' : 'missing',
        researchOwnsTab: (id: string, owner: string) => tabs.get(id) === owner,
        open: async ({ ownerThreadId, url }: { ownerThreadId: string; url: string }) => {
          tabs.set('owned', ownerThreadId); return { tabId: 'owned', nav: { navigationId: 'navigation', outcome: { kind: 'ok', finalUrl: url } } };
        },
        researchNavigationUrls: () => [h.source.requestedUrl], activate: () => {}, close: (id: string) => { tabs.delete(id); },
      };
      const reader = createBrowserReader({ browser: browser as unknown as BrowserService });
      h.deps.browserReader = reader; const service = new WebResearchTaskService(h.deps);
      await service.openSource(h.key); expect([...tabs.keys()]).toEqual(['owned']);
      if (keep) tabs.set('owned', null);
      if (action === 'dispose') await service.disposeThread(h.key.threadId);
      else if (action === 'shutdown') await service.shutdown();
      else await service.control(h.key.threadId, h.key.researchRunId, action);
      if (action === 'pause') {
        expect([...tabs.keys()]).toEqual(['owned']);
        await service.control(h.key.threadId, h.key.researchRunId, 'cancel');
      }
      expect([...tabs.keys()]).toEqual(keep ? ['owned'] : []);
      await reader.dispose();
    };
    await exercise(false); await exercise(true);
  });

  it('revokes a report publication already waiting on persistence before shutdown returns', async () => {
    const h = await harness();
    const good = await h.service.complete(h.key.threadId, h.key.researchRunId, 'Deferred', undefined, 'Deferred');
    expect(good.completed).toBe(true);
    const other = await harness(); const entered = deferred(), gate = deferred();
    const save = other.store.saveTask.bind(other.store);
    vi.spyOn(other.store, 'saveTask').mockImplementation(async task => {
      if (task.statusReason === 'finalizing_report') { entered.resolve(); await gate.promise; }
      return save(task);
    });
    const completing = other.service.complete(other.key.threadId, other.key.researchRunId, 'Deferred', undefined, 'Deferred');
    await entered.promise;
    const shutdown = other.service.shutdown();
    const rejected = expect(completing).rejects.toThrow('disposed');
    gate.resolve(); await shutdown; await rejected;
    expect((await readdir(other.root)).filter(name => name.endsWith('.md'))).toEqual([]);
  });

  it('does not emit a successful body from a persistence receipt arriving after shutdown', async () => {
    const h = await harness(); await h.service.retrySource({ ...h.key, expectedAttemptId: null }); await h.idle();
    expect((await h.saved()).status).toBe('completed');
    const other = await harness(); const entered = deferred(), gate = deferred();
    const updates: string[] = []; other.deps.onUpdate = value => { updates.push(`${value.status}:${value.counts.extracting}`); };
    const save = other.store.saveSource.bind(other.store);
    vi.spyOn(other.store, 'saveSource').mockImplementation(async (task, source) => {
      if (source.retrieval?.method === 'browser') { entered.resolve(); await gate.promise; }
      return save(task, source);
    });
    await other.service.retrySource({ ...other.key, expectedAttemptId: null }); await entered.promise;
    const before = [...updates]; const shutdown = other.service.shutdown(); gate.resolve(); await shutdown;
    expect(updates.slice(before.length)).toEqual(['paused:0']);
    expect((await other.saved()).status).toBe('waiting_user');
  });

  it('supersedes an in-flight browser attempt without leaving its reader alive', async () => {
    const h = await harness(); const started = deferred(), release = deferred(); let first!: BrowserReadInput;
    h.reader.read = vi.fn(async input => {
      if (!first) { first = input; await input.onStarted?.(); started.resolve(); await release.promise;
        const document = { url: input.requestedUrl, identity: { documentEpoch: 1, routeRevision: 0, navigationSequence: 1 }, rootRule: 'article', utf8Bytes: Buffer.byteLength(html) };
        await input.onDocument({ ...document, html }); return { status: 'readable' as const, document };
      }
      return readable(input);
    });
    await h.service.retrySource({ ...h.key, expectedAttemptId: null }); await started.promise;
    await h.service.retrySource({ ...h.key, expectedAttemptId: first.attemptId });
    const aborted = first.signal.aborted; release.resolve(); await h.idle();
    expect((await h.saved()).status).toBe('completed');
    expect(aborted).toBe(true);
    const completed = await h.saved(); expect(completed.browser!.attempts.map(attempt => attempt.phase)).toEqual(['interrupted', 'readable']);
    expect(completed.retrieval?.attemptId).toBe(completed.browser!.attempts[1].attemptId);
  });

  it('does not detach an active operation signal when resume is replayed on a running task', async () => {
    const h = await harness(); const started = deferred(), gate = deferred(); let input!: BrowserReadInput;
    h.reader.read = vi.fn(async value => { input = value; await value.onStarted?.(); started.resolve(); await gate.promise;
      return { status: 'waiting_user' as const, reason: 'browser_read_timeout' }; });
    await h.service.retrySource({ ...h.key, expectedAttemptId: null }); await started.promise;
    expect(input.signal.aborted).toBe(false);
    await h.service.control(h.key.threadId, h.key.researchRunId, 'resume');
    await h.service.control(h.key.threadId, h.key.researchRunId, 'pause');
    const aborted = input.signal.aborted; gate.resolve(); await h.idle();
    expect(aborted).toBe(true); expect((await h.saved()).reason).toBe('interrupted');
  });

  it('drains task creation that was already persisting before thread disposal', async () => {
    const h = await harness(); const entered = deferred(), gate = deferred();
    const create = h.store.createTask.bind(h.store); let newRun = '';
    vi.spyOn(h.store, 'createTask').mockImplementation(async task => { newRun = task.researchRunId; entered.resolve(); await gate.promise; return create(task); });
    const submission = h.service.submit({ originalQuestion: 'new', angles: [{ id: 'a', label: 'a', query: 'a' }] },
      { threadId: h.key.threadId, runId: randomUUID(), projectRoot: h.root });
    await entered.promise;
    let disposed = false; const stopping = h.service.disposeThread(h.key.threadId).then(() => { disposed = true; });
    await Promise.resolve(); await Promise.resolve(); const returnedEarly = disposed;
    const rejected = expect(submission).rejects.toThrow('disposed');
    gate.resolve(); await stopping; await rejected;
    expect(returnedEarly).toBe(false);
    // Creation really reached storage; teardown may safely delete after draining it.
    expect((await h.store.loadTask(h.key.threadId, newRun)).originalQuestion).toBe('new');
    await rm(path.join(h.root, h.key.threadId), { recursive: true });
    expect(await readdir(h.root)).toEqual([]);
  });

});
