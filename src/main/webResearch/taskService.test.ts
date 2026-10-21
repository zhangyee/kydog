import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebResearchTaskService } from './taskService';
import { TaskStore } from './taskStore';
import type { SearchObservation } from '../../shared/webResearchTask';
import type { FetchResult } from './fetchSource';
import type { SourceExtraction } from '../../shared/webResearch';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const threadId = randomUUID();
const runId = randomUUID();
const angles = [{ id: 'architecture', label: '架构', query: 'new architecture', rationale: '核对设计' }];

async function harness() {
  root = await mkdtemp(path.join(tmpdir(), 'kydog-task-'));
  const store = new TaskStore(root);
  let finishFetch!: () => void;
  const gate = new Promise<void>((resolve) => { finishFetch = resolve; });
  const fetch = vi.fn(async ({ url, sourceId, budget }: any): Promise<FetchResult> => {
    await gate;
    const bytes = new TextEncoder().encode('The new architecture uses parallel threads.');
    budget.reserveBytes(sourceId, bytes.length);
    return { requestedUrl: url, finalUrl: url, redirectChain: [], status: 'readable' as const,
      contentType: 'text/plain', bytes, receivedBytes: bytes.length };
  });
  const parse = vi.fn(async ({ bytes, sourceId }: any) => {
    const text = new TextDecoder().decode(bytes);
    return { status: 'readable' as const, completeness: 'complete' as const,
      contentHash: createHash('sha256').update(text).digest('hex'),
      passages: [{ passageId: `${sourceId}:p1`, sourceId, ordinal: 1, text }] };
  });
  const extract = vi.fn(async ({ sourceId }: any): Promise<SourceExtraction> => ({ sourceId, status: 'irrelevant',
    claims: [], evidence: [], examinedPassageIds: [`${sourceId}:p1`], gaps: [] }));
  const fetchIcon = vi.fn<(url: string, signal: AbortSignal) => Promise<string | undefined>>(
    async () => 'data:image/png;base64,aWNvbg==');
  const service = new WebResearchTaskService({ store, fetch, fetchIcon, parse, extract,
    resolveModel: async () => ({ providerId: 'test', modelId: 'model', runtimeRevision: 1 }),
    adapter: { currentRevision: () => 1, complete: async () => ({ text: '', stopReason: 'stop' }) },
    onUpdate: () => {} });
  const observation: SearchObservation = { observationId: randomUUID(), threadId,
    tabId: 'tab-1', engineId: 'bing', attemptId: randomUUID(), query: 'new architecture',
    searchPageUrl: 'https://www.bing.com/search?q=new+architecture', angleIds: ['architecture'],
    status: 'results',
    executionPath: 'search_url', inputSubmitted: true, navigationConfirmed: true,
    resultsExtracted: true, executionFacts: {
      startUrl: 'https://www.bing.com/search?q=new+architecture',
      endUrl: 'https://www.bing.com/search?q=new+architecture', successfulWaits: [],
    },
    createdAt: new Date().toISOString(), rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
    rows: [{ rawHref: 'https://docs.example/new', targetUrl: 'https://docs.example/new',
      title: 'New architecture', snippet: 'Parallel threads' }] };
  await store.saveObservation(observation);
  return { store, service, observation, fetch, fetchIcon, parse, extract, finishFetch };
}

describe('WebResearchTaskService', () => {
  it('submits only selected result indexes and reports each index outcome', async () => {
    const h = await harness();
    h.observation.rows = [
      { rawHref: 'https://docs.example/skip', targetUrl: 'https://docs.example/skip' },
      { rawHref: 'https://docs.example/one', targetUrl: 'https://docs.example/one' },
      { rawHref: 'https://www.bing.com/ck/a?id=2' },
      { rawHref: 'https://docs.example/one', targetUrl: 'https://docs.example/one' },
    ];
    await h.store.saveObservation(h.observation);
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationSelections: [{ observationId: h.observation.observationId, resultIndexes: [1, 2, 3] }] },
    { threadId, runId, projectRoot: root! });
    expect(submitted).toMatchObject({ accepted: 1, duplicates: 1, unresolved: 1, rejected: 0,
      observationResults: [{ observationId: h.observation.observationId, resultIndexes: [1, 2, 3],
        acceptedIndexes: [1], duplicateIndexes: [3], unresolvedIndexes: [2], rejectedIndexes: [] }] });
    expect(submitted.snapshot.counts.discoveries).toBe(3);
    expect((await h.store.loadTask(threadId, submitted.researchRunId)).observationSelections)
      .toEqual([{ observationId: h.observation.observationId, resultIndexes: [1, 2, 3] }]);
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
  });

  it('rejects invalid selections and overlap before locking an observation', async () => {
    const h = await harness();
    const selected = { observationId: h.observation.observationId, resultIndexes: [0, 0] };
    await expect(h.service.submit({ originalQuestion: 'What changed?', angles,
      observationSelections: [selected] }, { threadId, runId, projectRoot: root! }))
      .rejects.toThrow('indexes');
    await expect(h.service.submit({ originalQuestion: 'What changed?', angles,
      observationSelections: [{ ...selected, resultIndexes: [99] }] },
    { threadId, runId, projectRoot: root! })).rejects.toThrow('range');
    await expect(h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId],
      observationSelections: [{ ...selected, resultIndexes: [0] }] },
    { threadId, runId, projectRoot: root! })).rejects.toThrow('overlap');
    expect((await h.store.loadObservation(threadId, h.observation.observationId)).submittedToResearch)
      .toBeUndefined();
  });
  it('does not create a task when its angles or observation references are invalid', async () => {
    const h = await harness();
    await expect(h.service.submit({ originalQuestion: 'What changed?',
      angles: [{ ...angles[0], query: '' }] },
    { threadId, runId, projectRoot: root! })).rejects.toThrow('invalid angle');
    await expect(h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [randomUUID()] },
    { threadId, runId, projectRoot: root! })).rejects.toThrow('Search observation not found');
    expect(await h.store.listTasks(threadId)).toHaveLength(0);
  });

  it('acknowledges a submitted source before fetch completes, then exposes the completed source', async () => {
    const h = await harness();
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    expect(submitted.accepted).toBe(1);
    expect(submitted.snapshot.counts.queued + submitted.snapshot.counts.fetching).toBe(1);
    expect(h.extract).not.toHaveBeenCalled();
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    const overview = await h.service.inspect(threadId, submitted.researchRunId, { view: 'overview' });
    expect(overview.snapshot.counts.completed).toBe(1);
    expect(overview.snapshot.counts).toMatchObject({ evidenceReady: 0, irrelevant: 1 });
    const sources = await h.service.inspect(threadId, submitted.researchRunId, { view: 'sources' });
    expect(sources.items[0]).toMatchObject({ finalUrl: 'https://docs.example/new', status: 'completed' });
  });

  it('attaches a rowless blocked probe and exposes its protocol facts in overview', async () => {
    const h = await harness();
    const blocked: SearchObservation = {
      observationId: randomUUID(), threadId, tabId: 'google-tab', engineId: 'google',
      attemptId: randomUUID(), query: 'new architecture',
      searchPageUrl: 'https://www.google.com/sorry/index', angleIds: ['architecture'],
      status: 'blocked', executionPath: 'status_only', inputSubmitted: false,
      navigationConfirmed: false, resultsExtracted: false,
      executionFacts: { startUrl: 'https://www.google.com/',
        endUrl: 'https://www.google.com/sorry/index', successfulWaits: [] },
      createdAt: new Date().toISOString(),
      rowTruncation: { truncated: false, returned: 0, totalKnown: 0 }, rows: [],
    };
    await h.store.saveObservation(blocked);
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [blocked.observationId] }, { threadId, runId, projectRoot: root! });
    expect(submitted).toMatchObject({ accepted: 0, unresolved: 0,
      observationResults: [{ observationId: blocked.observationId, resultIndexes: [],
        acceptedIndexes: [], duplicateIndexes: [], unresolvedIndexes: [], rejectedIndexes: [] }] });
    const overview = await h.service.inspect(threadId, submitted.researchRunId, { view: 'overview' });
    expect(overview.items).toEqual([expect.objectContaining({
      observationId: blocked.observationId, engineId: 'google', status: 'blocked',
      executionPath: 'status_only', inputSubmitted: false, navigationConfirmed: false,
      resultsExtracted: false, candidateCount: 0, confirmedCount: 0, unresolvedCount: 0,
    })]);
    expect((await h.store.loadObservation(threadId, blocked.observationId))
      .submittedToResearch?.researchRunId).toBe(submitted.researchRunId);
  });

  it('exposes a saved search-action failure in overview instead of losing it behind a status', async () => {
    const h = await harness();
    const failed: SearchObservation = {
      observationId: randomUUID(), threadId, tabId: 'ddg-tab', engineId: 'duckduckgo',
      attemptId: randomUUID(), query: 'new architecture',
      searchPageUrl: 'https://duckduckgo.com/', angleIds: ['architecture'],
      status: 'submission_error', executionPath: 'homepage_form', inputSubmitted: false,
      navigationConfirmed: false, resultsExtracted: false,
      executionFacts: { startUrl: 'https://duckduckgo.com/',
        endUrl: 'https://duckduckgo.com/', successfulWaits: [] },
      failure: { stage: 'submission', actionIndex: 1, actionKind: 'click',
        selector: 'form button[type=submit]', message: '目标元素不存在' },
      createdAt: new Date().toISOString(),
      rowTruncation: { truncated: false, returned: 0, totalKnown: 0 }, rows: [],
    };
    await h.store.saveObservation(failed);
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [failed.observationId] }, { threadId, runId, projectRoot: root! });
    const overview = await h.service.inspect(threadId, submitted.researchRunId, { view: 'overview' });
    expect(overview.items).toEqual([expect.objectContaining({
      status: 'submission_error', failure: failed.failure,
    })]);
  });

  it('publishes exact processed counts and deduplicated site summaries with available icons', async () => {
    const h = await harness();
    h.observation.rows = [
      { rawHref: 'https://docs.example/one', targetUrl: 'https://docs.example/one' },
      { rawHref: 'https://docs.example/two', targetUrl: 'https://docs.example/two' },
      { rawHref: 'https://other.example/three', targetUrl: 'https://other.example/three' },
    ];
    h.parse.mockImplementation(async ({ bytes, sourceId, finalUrl }: any) => {
      const text = new TextDecoder().decode(bytes);
      return { status: 'readable', completeness: 'complete',
        contentHash: createHash('sha256').update(text).digest('hex'),
        passages: [{ passageId: `${sourceId}:p1`, sourceId, ordinal: 1, text }],
        siteIconUrl: finalUrl.includes('docs.example') ? 'https://docs.example/icon.png' : undefined };
    });
    await h.store.saveObservation(h.observation);
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    expect(submitted.snapshot.counts.processed).toBe(0);
    expect(submitted.snapshot.sites.map((site) => site.domain)).toEqual(['docs.example', 'other.example']);
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    const finished = await h.service.get(threadId, submitted.researchRunId);
    expect(finished.counts.processed).toBe(3);
    expect(finished.sites).toEqual([
      { domain: 'docs.example', sourceCount: 2, processed: 2,
        iconAvailable: true },
      { domain: 'other.example', sourceCount: 1, processed: 1, iconAvailable: false },
    ]);
    expect(h.fetchIcon).not.toHaveBeenCalled();
    await expect(h.service.siteIcon(threadId, submitted.researchRunId, 'docs.example'))
      .resolves.toBe('data:image/png;base64,aWNvbg==');
    await expect(h.service.siteIcon(threadId, submitted.researchRunId, 'docs.example'))
      .resolves.toBe('data:image/png;base64,aWNvbg==');
    expect(h.fetchIcon).toHaveBeenCalledTimes(1);
  });

  it('does not let a stalled site icon request delay source processing', async () => {
    const h = await harness();
    h.parse.mockImplementation(async ({ bytes, sourceId }: any) => {
      const text = new TextDecoder().decode(bytes);
      return { status: 'readable', completeness: 'complete',
        contentHash: createHash('sha256').update(text).digest('hex'),
        passages: [{ passageId: `${sourceId}:p1`, sourceId, ordinal: 1, text }],
        siteIconUrl: 'https://docs.example/icon.png' };
    });
    h.fetchIcon.mockImplementation(async (): Promise<string | undefined> =>
      new Promise<string | undefined>(() => {}));
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    expect((await h.service.get(threadId, submitted.researchRunId)).counts.completed).toBe(1);
    await expect(h.service.siteIcon(threadId, submitted.researchRunId, 'docs.example', 5))
      .resolves.toBeUndefined();
  });

  it('deduplicates 1,000 discoveries to 300 sources without losing their provenance', async () => {
    const h = await harness();
    const observations = Array.from({ length: 20 }, (_, page): SearchObservation => ({
      ...h.observation, observationId: randomUUID(), attemptId: randomUUID(),
      rows: Array.from({ length: 50 }, (_, row) => {
        const url = `https://docs.example/${(page * 50 + row) % 300}`;
        return { rawHref: url, targetUrl: url, title: `Result ${page * 50 + row}` };
      }),
      rowTruncation: { truncated: false, returned: 50, totalKnown: 50 },
    }));
    for (const observation of observations) await h.store.saveObservation(observation);
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: observations.map((item) => item.observationId) },
    { threadId, runId, projectRoot: root! });
    expect(submitted.accepted).toBe(300);
    expect(submitted.duplicates).toBe(700);
    expect(submitted.snapshot.counts.discoveries).toBe(1000);
    expect(submitted.snapshot.counts.queued + submitted.snapshot.counts.fetching).toBe(300);
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
  });

  it('pages every claim beyond the former first-page cutoff', async () => {
    const h = await harness();
    h.extract.mockImplementation(async ({ sourceId }: any) => ({ sourceId, status: 'claims',
      claims: [{ claimId: `claim-${sourceId}`, sourceId, statement: `Claim ${sourceId}`,
        relevantAngleIds: ['architecture'], evidenceIds: [], verification: 'unverified' }],
      evidence: [], examinedPassageIds: [`${sourceId}:p1`], gaps: [] }));
    h.observation.rows = Array.from({ length: 65 }, (_, index) => {
      const url = `https://docs.example/${index}`;
      return { rawHref: url, targetUrl: url };
    });
    await h.store.saveObservation(h.observation);
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    const first = await h.service.inspect(threadId, submitted.researchRunId,
      { view: 'claims', pageSize: 50 });
    const second = await h.service.inspect(threadId, submitted.researchRunId,
      { view: 'claims', pageSize: 50, cursor: first.nextCursor });
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBe('50');
    expect(second.items).toHaveLength(15);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map((item: any) => item.claimId)).size).toBe(65);
  });

  it('starts extraction for one source while another fetch is still pending', async () => {
    const h = await harness();
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    h.fetch.mockImplementation(async ({ url, sourceId, budget }: any) => {
      if (url.endsWith('/second')) await secondGate;
      const bytes = new TextEncoder().encode('Parallel threads coordinate work.');
      budget.reserveBytes(sourceId, bytes.length);
      return { requestedUrl: url, finalUrl: url, redirectChain: [], status: 'readable',
        contentType: 'text/plain', bytes, receivedBytes: bytes.length };
    });
    h.observation.rows = [
      { rawHref: 'https://docs.example/first', targetUrl: 'https://docs.example/first' },
      { rawHref: 'https://docs.example/second', targetUrl: 'https://docs.example/second' },
    ];
    await h.store.saveObservation(h.observation);
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    await vi.waitFor(() => expect(h.extract).toHaveBeenCalledTimes(1));
    expect((await h.service.get(threadId, submitted.researchRunId)).counts.fetching).toBe(1);
    releaseSecond();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    expect((await h.service.get(threadId, submitted.researchRunId)).counts.completed).toBe(2);
  });

  it('pauses with queued work at the fetch budget, then resumes after the limit is raised', async () => {
    const h = await harness();
    h.observation.rows = [
      { rawHref: 'https://docs.example/first', targetUrl: 'https://docs.example/first' },
      { rawHref: 'https://docs.example/second', targetUrl: 'https://docs.example/second' },
    ];
    await h.store.saveObservation(h.observation);
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId], budget: { maxFetches: 1, fetchConcurrency: 1 } },
    { threadId, runId, projectRoot: root! });
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    const paused = await h.service.get(threadId, submitted.researchRunId);
    expect(paused).toMatchObject({ status: 'paused', statusReason: 'fetch_limit',
      counts: { completed: 1, queued: 1 } });
    await h.service.submit({ researchRunId: submitted.researchRunId, budget: { maxFetches: 2 } },
      { threadId, runId, projectRoot: root! });
    await h.service.control(threadId, submitted.researchRunId, 'resume');
    await h.service.whenIdle(threadId, submitted.researchRunId);
    expect((await h.service.get(threadId, submitted.researchRunId)).counts.completed).toBe(2);
  });

  it('replays candidate-limited observations after the candidate budget is raised', async () => {
    const h = await harness();
    h.observation.rows = [
      { rawHref: 'https://docs.example/first', targetUrl: 'https://docs.example/first' },
      { rawHref: 'https://docs.example/second', targetUrl: 'https://docs.example/second' },
    ];
    await h.store.saveObservation(h.observation);
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId], budget: { maxCandidates: 1 } },
    { threadId, runId, projectRoot: root! });
    expect(submitted).toMatchObject({ accepted: 1, rejected: 1,
      snapshot: { status: 'paused', counts: { discoveries: 2, sources: 1 } } });
    const raised = await h.service.submit({ researchRunId: submitted.researchRunId,
      budget: { maxCandidates: 2 } }, { threadId, runId, projectRoot: root! });
    expect(raised).toMatchObject({ accepted: 1, rejected: 0,
      snapshot: { counts: { discoveries: 2, sources: 2 } } });
    h.finishFetch();
    await h.service.control(threadId, submitted.researchRunId, 'resume');
    await h.service.whenIdle(threadId, submitted.researchRunId);
    expect((await h.service.get(threadId, submitted.researchRunId)).counts.completed).toBe(2);
  });

  it('pauses and retries a source after the total byte budget is raised', async () => {
    const h = await harness();
    h.fetch.mockImplementationOnce(async ({ url, sourceId, budget }: any) => {
      expect(budget.reserveBytes(sourceId, 10)).toMatchObject({ ok: true });
      expect(budget.reserveBytes(sourceId, 1)).toMatchObject({ ok: false, reason: 'total_byte_limit' });
      return { requestedUrl: url, finalUrl: url, redirectChain: [], status: 'unreadable',
        reason: 'total_byte_limit', bytes: new Uint8Array(), receivedBytes: 10 };
    });
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId], budget: { maxTotalBytes: 10 } },
    { threadId, runId, projectRoot: root! });
    await h.service.whenIdle(threadId, submitted.researchRunId);
    expect(await h.service.get(threadId, submitted.researchRunId)).toMatchObject({
      status: 'paused', statusReason: 'total_byte_limit', counts: { queued: 1, failed: 0 } });
    await h.service.submit({ researchRunId: submitted.researchRunId,
      budget: { maxTotalBytes: 100 } }, { threadId, runId, projectRoot: root! });
    h.finishFetch();
    await h.service.control(threadId, submitted.researchRunId, 'resume');
    await h.service.whenIdle(threadId, submitted.researchRunId);
    expect((await h.service.get(threadId, submitted.researchRunId)).counts.completed).toBe(1);
  });

  it('does not turn an aborted in-flight fetch into a failed source when resumed immediately', async () => {
    const h = await harness();
    let releaseAborted!: () => void;
    const abortedGate = new Promise<void>((resolve) => { releaseAborted = resolve; });
    h.fetch.mockImplementationOnce(async ({ url, signal }: any) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      await abortedGate;
      return { requestedUrl: url, finalUrl: url, redirectChain: [], status: 'cancelled',
        reason: 'cancelled', bytes: new Uint8Array(), receivedBytes: 0 };
    });
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    await h.service.control(threadId, submitted.researchRunId, 'pause');
    await h.service.control(threadId, submitted.researchRunId, 'resume');
    releaseAborted();
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    expect((await h.service.get(threadId, submitted.researchRunId)).counts.completed).toBe(1);
    expect((await h.service.get(threadId, submitted.researchRunId)).counts.failed).toBe(0);
  });

  it('settles in-flight work as cancelled sources when cancelling a task', async () => {
    const h = await harness();
    h.fetch.mockImplementationOnce(async ({ url, signal }: any) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return { requestedUrl: url, finalUrl: url, redirectChain: [], status: 'cancelled',
        reason: 'cancelled', bytes: new Uint8Array(), receivedBytes: 0 };
    });
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const cancelled = await h.service.control(threadId, submitted.researchRunId, 'cancel');
    expect(cancelled).toMatchObject({ status: 'cancelled', counts: { cancelled: 1, queued: 0 } });
  });

  it('recovers an interrupted extraction from saved passages without refetching the page', async () => {
    const h = await harness();
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    const task = await h.store.loadTask(threadId, submitted.researchRunId);
    const [source] = await h.store.listSources(task);
    source.status = 'extracting';
    await h.store.saveSource(task, source);
    const recovered = new WebResearchTaskService({ store: h.store, fetch: h.fetch, parse: h.parse,
      extract: h.extract, resolveModel: async () => ({ providerId: 'test', modelId: 'model', runtimeRevision: 1 }),
      adapter: { currentRevision: () => 1, complete: async () => ({ text: '', stopReason: 'stop' }) },
      onUpdate: () => {} });
    await recovered.whenIdle(threadId, submitted.researchRunId);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.extract).toHaveBeenCalledTimes(2);
    expect((await recovered.get(threadId, submitted.researchRunId)).counts.completed).toBe(1);
  });

  it('repairs persisted counters when a source file is ahead of task metadata at restart', async () => {
    const h = await harness();
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    const task = await h.store.loadTask(threadId, submitted.researchRunId);
    const savedBytes = task.usage.receivedBytes;
    expect(savedBytes).toBeGreaterThan(0);
    task.usage = { candidates: 0, fetchesDispatched: 0, receivedBytes: 0, modelCalls: 0 };
    await h.store.saveTask(task);
    const recovered = new WebResearchTaskService({ store: h.store, fetch: h.fetch, parse: h.parse,
      extract: h.extract, resolveModel: async () => ({ providerId: 'test', modelId: 'model', runtimeRevision: 1 }),
      adapter: { currentRevision: () => 1, complete: async () => ({ text: '', stopReason: 'stop' }) },
      onUpdate: () => {} });
    expect(await recovered.get(threadId, submitted.researchRunId)).toMatchObject({
      counts: { completed: 1 }, usage: { candidates: 1, fetchesDispatched: 1, receivedBytes: savedBytes } });
  });

  it('loads one runtime when renderer and agent inspect the same recovered task concurrently', async () => {
    const h = await harness();
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    const loadTask = vi.spyOn(h.store, 'loadTask');
    const recovered = new WebResearchTaskService({ store: h.store, fetch: h.fetch, parse: h.parse,
      extract: h.extract, resolveModel: async () => ({ providerId: 'test', modelId: 'model', runtimeRevision: 1 }),
      adapter: { currentRevision: () => 1, complete: async () => ({ text: '', stopReason: 'stop' }) },
      onUpdate: () => {} });
    await Promise.all([
      recovered.get(threadId, submitted.researchRunId),
      recovered.inspect(threadId, submitted.researchRunId, { view: 'overview' }),
      recovered.get(threadId, submitted.researchRunId),
    ]);
    expect(loadTask).toHaveBeenCalledTimes(1);
  });

  it('reanalyzes a completed page when a later IAB observation adds a new angle context', async () => {
    const h = await harness();
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    h.finishFetch();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    const second = { ...h.observation, observationId: randomUUID(), attemptId: randomUUID(),
      query: 'architecture coordination', createdAt: new Date().toISOString() };
    await h.store.saveObservation(second);
    await h.service.submit({ researchRunId: submitted.researchRunId,
      observationIds: [second.observationId] }, { threadId, runId, projectRoot: root! });
    await h.service.whenIdle(threadId, submitted.researchRunId);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.extract).toHaveBeenCalledTimes(2);
    const task = await h.store.loadTask(threadId, submitted.researchRunId);
    expect((await h.store.listSources(task))[0].discoveries).toHaveLength(2);
  });

  it('reanalyzes a page when a discovery arrives during its first extraction', async () => {
    const h = await harness();
    h.finishFetch();
    let releaseExtraction!: () => void;
    const extractionGate = new Promise<void>((resolve) => { releaseExtraction = resolve; });
    h.extract.mockImplementationOnce(async ({ sourceId }: any) => {
      await extractionGate;
      return { sourceId, status: 'irrelevant', claims: [], evidence: [],
        examinedPassageIds: [`${sourceId}:p1`], gaps: [] };
    });
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    await vi.waitFor(() => expect(h.extract).toHaveBeenCalledTimes(1));
    const second = { ...h.observation, observationId: randomUUID(), attemptId: randomUUID(),
      query: 'architecture coordination', createdAt: new Date().toISOString() };
    await h.store.saveObservation(second);
    await h.service.submit({ researchRunId: submitted.researchRunId,
      observationIds: [second.observationId] }, { threadId, runId, projectRoot: root! });
    releaseExtraction();
    await h.service.whenIdle(threadId, submitted.researchRunId);
    expect(h.extract).toHaveBeenCalledTimes(2);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('stops queued source work before completing a report with an unprocessed reason', async () => {
    const h = await harness();
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    h.fetch.mockImplementationOnce(async ({ url, signal }: any) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await fetchGate;
      return { requestedUrl: url, finalUrl: url, redirectChain: [], status: 'cancelled',
        reason: 'cancelled', bytes: new Uint8Array(), receivedBytes: 0 };
    });
    h.observation.rows = [
      { rawHref: 'https://docs.example/first', targetUrl: 'https://docs.example/first' },
      { rawHref: 'https://docs.example/second', targetUrl: 'https://docs.example/second' },
    ];
    await h.store.saveObservation(h.observation);
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId], budget: { fetchConcurrency: 1 } },
    { threadId, runId, projectRoot: root! });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    const completion = h.service.complete(threadId, submitted.researchRunId,
      '# Report\n\nNo verified conclusions yet. Stopped after initial search.\n',
      'research.md', 'Stopped after initial search');
    releaseFetch();
    const finished = await completion;
    expect(finished.completed).toBe(true);
    expect(finished.snapshot.status).toBe('completed');
    expect(finished.snapshot.counts.unprocessed).toBe(2);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns all citation diagnostics without pausing or writing a report', async () => {
    const h = await harness();
    h.finishFetch();
    const submitted = await h.service.submit({ originalQuestion: 'What changed?', angles,
      observationIds: [h.observation.observationId] }, { threadId, runId, projectRoot: root! });
    await h.service.whenIdle(threadId, submitted.researchRunId);
    const completed = await h.service.complete(threadId, submitted.researchRunId,
      '# Report\n\nUnsupported. [来源](https://wrong.example/)〔证据:missing〕\n');
    expect(completed).toMatchObject({ completed: false,
      validationErrors: [{ code: 'evidence_missing', line: 3, evidenceIds: ['missing'] }] });
    expect(await h.service.get(threadId, submitted.researchRunId)).toMatchObject({
      status: 'running', statusReason: undefined, reportPath: undefined });
    expect((await readdir(root!)).filter((name) => name.endsWith('.md'))).toEqual([]);
  });
});
