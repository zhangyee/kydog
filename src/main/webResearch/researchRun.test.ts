import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CollectInput, Discovery, SearchEngineId, SourceExtraction } from '../../shared/webResearch';
import { DEFAULT_RESEARCH_BUDGET } from './budget';
import type { FetchResult } from './fetchSource';
import { ResearchFixtureExhaustedError, type ExtractSourceInput } from './extractClaims';
import { ResearchRunService } from './researchRun';
import { RunStore } from './runStore';

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const threadId = randomUUID();
const owner = (signal = new AbortController().signal) => ({ threadId, runId: randomUUID(), toolCallId: 'call-1', signal });
function input(url: string, engineId: SearchEngineId, query: string, researchRunId?: string, refresh = false): CollectInput {
  const attemptId = randomUUID();
  const discovery: Discovery = { attemptId, angleId: 'a', engineId, query, resultUrl: url,
    searchPageUrl: `https://search.example/?q=${encodeURIComponent(query)}`, snippet: `result for ${query}` };
  return { researchRunId, originalQuestion: 'V2 需要 HTTPS 吗？',
    angles: [{ id: 'a', label: '安全协议', query }], enabledEngines: [engineId],
    attempts: [{ attemptId, angleIds: ['a'], engineId, query, status: 'results', searchPageUrl: discovery.searchPageUrl }],
    discoveries: [discovery], budget: { ...DEFAULT_RESEARCH_BUDGET, fetchConcurrency: 2 }, refresh };
}
async function harness(body = '新版要求 HTTPS。') {
  root = await mkdtemp(path.join(tmpdir(), 'kydog-research-run-'));
  const store = new RunStore(root);
  let currentBody = body;
  let currentRevision = 1;
  const fetch = vi.fn(async ({ url, sourceId, budget, signal }: {
    url: string; sourceId: string; budget: import('./budget').ResearchBudgetMeter; signal: AbortSignal;
  }): Promise<FetchResult> => {
    expect(signal.aborted).toBe(false);
    const bytes = new TextEncoder().encode(currentBody);
    budget.reserveBytes(sourceId, bytes.length);
    return { requestedUrl: url, finalUrl: url, redirectChain: [], status: 'readable',
      contentType: 'text/plain', bytes, receivedBytes: bytes.length };
  });
  const parse = vi.fn(async ({ bytes, sourceId }: { bytes: Uint8Array; sourceId: string }) => {
    const text = new TextDecoder().decode(bytes);
    return { status: 'readable' as const, completeness: 'complete' as const,
      contentHash: createHash('sha256').update(text).digest('hex'),
      passages: [{ passageId: `${sourceId}:p1`, sourceId, ordinal: 1, text }] };
  });
  const extract = vi.fn(async ({ sourceId }: ExtractSourceInput): Promise<SourceExtraction> => ({ sourceId, status: 'irrelevant',
    claims: [], evidence: [], examinedPassageIds: [`${sourceId}:p1`], gaps: [] }));
  const resolveModel = vi.fn(async () => ({ providerId: 'test', modelId: 'model',
    runtimeRevision: currentRevision }));
  const service = new ResearchRunService({ store, fetch, parse, extract,
    resolveModel,
    adapter: { currentRevision: () => currentRevision, complete: async () => ({ text: '', stopReason: 'stop' }) } });
  return { store, service, fetch, parse, extract, resolveModel,
    setBody: (value: string) => { currentBody = value; },
    setRevision: (value: number) => { currentRevision = value; } };
}

describe('ResearchRunService', () => {
  it('reanalyzes a completed URL when a later search adds discovery context without refetching', async () => {
    const h = await harness();
    const first = await h.service.collect(input('https://docs.example/v2', 'bing', 'v2 protocol'), owner(), () => {});
    expect(first.sources).toHaveLength(1);
    const second = await h.service.collect(input('https://docs.example/v2', 'duckduckgo', 'v2 migration',
      first.researchRunId), owner(), () => {});
    expect(second.sources).toHaveLength(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.extract).toHaveBeenCalledTimes(2);
    expect(h.extract.mock.calls[1][0].discoveries.map((item) => item.engineId))
      .toEqual(['bing', 'duckduckgo']);
    const saved = await h.store.loadRun(threadId, first.researchRunId);
    expect(saved.attempts).toHaveLength(2);
    expect(saved.sources[0].discoveries.map((item) => item.engineId)).toEqual(['bing', 'duckduckgo']);
    expect(saved.usage.fetchesDispatched).toBe(1);
  });

  it('persists pending reanalysis across an interrupted extraction and retries it without new discoveries', async () => {
    const h = await harness();
    const first = await h.service.collect(input('https://docs.example/v2', 'bing', 'old'), owner(), () => {});
    h.extract.mockImplementationOnce(async () => { throw new ResearchFixtureExhaustedError('simulated interruption'); });
    await expect(h.service.collect(input('https://docs.example/v2', 'duckduckgo', 'new',
      first.researchRunId), owner(), () => {})).rejects.toThrow('simulated interruption');
    let saved = await h.store.loadRun(threadId, first.researchRunId);
    expect(saved.sources[0].status).toBe('completed');
    expect(saved.sources[0].pendingReanalysis).toBe(true);
    const retry = input('https://docs.example/v2', 'duckduckgo', 'new', first.researchRunId);
    retry.discoveries = [];
    retry.attempts = [];
    await h.service.collect(retry, owner(), () => {});
    saved = await h.store.loadRun(threadId, first.researchRunId);
    expect(saved.sources[0].pendingReanalysis).toBe(false);
    expect(h.extract).toHaveBeenCalledTimes(3);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('reuses extraction for an unchanged refresh, then reanalyzes when body or discovery changes', async () => {
    const h = await harness();
    const url = 'https://docs.example/v2';
    const initial = input(url, 'bing', 'v2');
    const first = await h.service.collect(initial, owner(), () => {});
    await h.service.collect({ ...initial, researchRunId: first.researchRunId, refresh: true }, owner(), () => {});
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.extract).toHaveBeenCalledTimes(1);
    await h.service.collect(input(url, 'bing', 'v2 new context', first.researchRunId, true), owner(), () => {});
    expect(h.extract).toHaveBeenCalledTimes(2);
    h.setBody('新版仍允许 HTTP。');
    await h.service.collect(input(url, 'bing', 'v2 changed', first.researchRunId, true), owner(), () => {});
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.extract).toHaveBeenCalledTimes(3);
  });

  it('refreshes saved URLs when no new discoveries are supplied', async () => {
    const h = await harness();
    const first = await h.service.collect(input('https://docs.example/v2', 'bing', 'v2'), owner(), () => {});
    const refresh = input('https://docs.example/v2', 'bing', 'v2', first.researchRunId, true);
    refresh.discoveries = [];
    refresh.attempts = [];
    await h.service.collect(refresh, owner(), () => {});
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('records a URL explicitly labeled PDF without dispatching a body request', async () => {
    const h = await harness();
    const result = await h.service.collect(input('https://docs.example/paper.PDF?download=1',
      'bing', 'paper'), owner(), () => {});
    expect(result.sources[0]).toMatchObject({ status: 'failed', reason: 'pdf_url_excluded' });
    expect(h.fetch).toHaveBeenCalledTimes(0);
    expect(result.usage.fetchesDispatched).toBe(0);
  });

  it('keeps the prior extraction when a refresh cannot fetch the source', async () => {
    const h = await harness();
    const first = await h.service.collect(input('https://docs.example/v2', 'bing', 'v2'), owner(), () => {});
    h.fetch.mockImplementationOnce(async ({ url }) => ({ requestedUrl: url, finalUrl: url,
      redirectChain: [], status: 'network_error', reason: 'request_failed', bytes: new Uint8Array(),
      receivedBytes: 0 }));
    const later = await h.service.collect(input('https://docs.example/v2', 'bing', 'v2',
      first.researchRunId, true), owner(), () => {});
    expect(later.sources[0]).toMatchObject({ status: 'completed', reason: 'refresh_request_failed' });
    const saved = await h.store.loadRun(threadId, first.researchRunId);
    expect((await h.store.loadSource(saved, saved.sources[0].sourceId)).extraction?.status).toBe('irrelevant');
  });

  it('keeps new discovery provenance when a refresh fetch fails', async () => {
    const h = await harness();
    const first = await h.service.collect(input('https://docs.example/v2', 'bing', 'old'), owner(), () => {});
    h.fetch.mockImplementationOnce(async ({ url }) => ({ requestedUrl: url, finalUrl: url,
      redirectChain: [], status: 'network_error', reason: 'request_failed', bytes: new Uint8Array(),
      receivedBytes: 0 }));
    await h.service.collect(input('https://docs.example/v2', 'duckduckgo', 'new',
      first.researchRunId, true), owner(), () => {});
    const saved = await h.store.loadRun(threadId, first.researchRunId);
    expect(saved.sources[0].discoveries.map((item) => item.query)).toEqual(['old', 'new']);
    expect(saved.sources[0].pendingReanalysis).toBe(true);
  });

  it('keeps the prior extraction if refresh is cancelled after parsing an unchanged body', async () => {
    const h = await harness();
    const first = await h.service.collect(input('https://docs.example/v2', 'bing', 'v2'), owner(), () => {});
    const controller = new AbortController();
    h.parse.mockImplementationOnce(async ({ bytes, sourceId }) => {
      controller.abort();
      const text = new TextDecoder().decode(bytes);
      return { status: 'readable', completeness: 'complete',
        contentHash: createHash('sha256').update(text).digest('hex'),
        passages: [{ passageId: `${sourceId}:p1`, sourceId, ordinal: 1, text }] };
    });
    const later = await h.service.collect(input('https://docs.example/v2', 'bing', 'v2',
      first.researchRunId, true), owner(controller.signal), () => {});
    expect(later.sources[0]).toMatchObject({ status: 'completed', reason: 'reanalysis_aborted' });
    const saved = await h.store.loadRun(threadId, first.researchRunId);
    expect((await h.store.loadSource(saved, saved.sources[0].sourceId)).extraction?.status).toBe('irrelevant');
  });

  it('restores an untouched completed source when a refresh batch is cancelled', async () => {
    const h = await harness();
    const firstInput = input('https://docs.example/a', 'bing', 'q1');
    firstInput.budget.fetchConcurrency = 1;
    const secondInput = input('https://docs.example/b', 'bing', 'q2');
    const combined = { ...firstInput, attempts: [...firstInput.attempts, ...secondInput.attempts],
      discoveries: [...firstInput.discoveries, ...secondInput.discoveries] };
    const first = await h.service.collect(combined, owner(), () => {});
    const controller = new AbortController();
    h.fetch.mockImplementationOnce(async ({ url }) => {
      controller.abort();
      return { requestedUrl: url, finalUrl: url, redirectChain: [], status: 'cancelled',
        reason: 'cancelled', bytes: new Uint8Array(), receivedBytes: 0 };
    });
    const refreshed = await h.service.collect({ ...combined, researchRunId: first.researchRunId,
      attempts: [], discoveries: [], refresh: true }, owner(controller.signal), () => {});
    expect(refreshed.sources.map((source) => source.status)).toEqual(['completed', 'completed']);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    const saved = await h.store.loadRun(threadId, first.researchRunId);
    expect((await h.store.loadSource(saved, saved.sources[1].sourceId)).extraction?.status).toBe('irrelevant');
  });

  it('applies explicitly raised continuation limits without resetting them on a later default batch', async () => {
    const h = await harness();
    const first = input('https://docs.example/a', 'bing', 'q1');
    first.budget.maxFetches = 1;
    const initial = await h.service.collect(first, owner(), () => {});
    const second = input('https://docs.example/b', 'bing', 'q2', initial.researchRunId);
    second.budgetOverrides = { maxFetches: 2, maxTotalBytes: 2 * DEFAULT_RESEARCH_BUDGET.maxTotalBytes,
      maxModelCalls: 2 * DEFAULT_RESEARCH_BUDGET.maxModelCalls };
    const raised = await h.service.collect(second, owner(), () => {});
    expect(raised.usage.fetchesDispatched).toBe(2);
    expect(raised.budget.maxFetches).toBe(2);
    const third = input('https://docs.example/c', 'bing', 'q3', initial.researchRunId);
    const final = await h.service.collect(third, owner(), () => {});
    expect(final.budget.maxFetches).toBe(2);
    expect(final.sources.at(-1)?.reason).toBe('fetch_limit');
  });

  it('rejects a continuation budget decrease before changing the saved run', async () => {
    const h = await harness();
    const first = await h.service.collect(input('https://docs.example/a', 'bing', 'q1'), owner(), () => {});
    const next = input('https://docs.example/b', 'bing', 'q2', first.researchRunId);
    next.budgetOverrides = { maxFetches: first.budget.maxFetches - 1 };
    await expect(h.service.collect(next, owner(), () => {})).rejects.toThrow('budget');
    const saved = await h.store.loadRun(threadId, first.researchRunId);
    expect(saved.budget.maxFetches).toBe(first.budget.maxFetches);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('persists fetch provenance, creator and continuation IDs, and its model snapshot', async () => {
    const h = await harness();
    h.fetch.mockImplementationOnce(async ({ url, sourceId, budget }) => {
      const bytes = new TextEncoder().encode('source body');
      budget.reserveBytes(sourceId, bytes.length);
      return { requestedUrl: url, finalUrl: 'https://docs.example/final',
        redirectChain: [{ fromUrl: url, toUrl: 'https://docs.example/final', kind: 'http', statusCode: 302 }],
        status: 'readable', statusCode: 200, contentType: 'text/html',
        canonicalUrl: 'https://docs.example/canonical', assurance: 'dns_pinned', bytes,
        receivedBytes: bytes.length };
    });
    h.parse.mockImplementationOnce(async ({ bytes, sourceId }) => ({ status: 'readable',
      completeness: 'complete', contentHash: createHash('sha256').update(bytes).digest('hex'),
      publishedAt: '2026-09-25', passages: [{ passageId: `${sourceId}:p1`, sourceId, ordinal: 1,
        text: new TextDecoder().decode(bytes) }] }));
    const creator = owner();
    const first = await h.service.collect(input('https://docs.example/old', 'bing', 'q1'), creator, () => {});
    const continuer = owner();
    await h.service.collect(input('https://docs.example/other', 'bing', 'q2', first.researchRunId),
      continuer, () => {});
    const saved = await h.store.loadRun(threadId, first.researchRunId);
    expect(saved.createdByRunId).toBe(creator.runId);
    expect(saved.continuationRunIds).toEqual([continuer.runId]);
    expect(saved.modelSnapshot).toEqual({ providerId: 'test', modelId: 'model', runtimeRevision: 1 });
    expect(saved.sources[0]).toMatchObject({
      finalUrl: 'https://docs.example/final', statusCode: 200, contentType: 'text/html',
      canonicalUrl: 'https://docs.example/canonical', publishedAt: '2026-09-25',
      assurance: 'dns_pinned',
      redirectChain: [{ fromUrl: 'https://docs.example/old', toUrl: 'https://docs.example/final',
        kind: 'http', statusCode: 302 }],
    });
  });

  it('preserves observed search attempts when a changed model blocks new extraction', async () => {
    const h = await harness();
    const first = await h.service.collect(input('https://docs.example/a', 'bing', 'q1'), owner(), () => {});
    h.setRevision(2);
    const next = input('https://docs.example/b', 'bing', 'q2', first.researchRunId);
    await expect(h.service.collect(next, owner(), () => {})).rejects.toThrow('model_changed');
    const saved = await h.store.loadRun(threadId, first.researchRunId);
    expect(saved.attempts.map((attempt) => attempt.query)).toEqual(['q1', 'q2']);
    expect(saved.candidates.map((candidate) => candidate.requestedUrl)).toContain('https://docs.example/b');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('reserves the run lock before awaiting model resolution on continuation', async () => {
    const h = await harness();
    const first = await h.service.collect(input('https://docs.example/a', 'bing', 'q1'), owner(), () => {});
    let entered!: () => void;
    const resolving = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let resolutions = 0;
    h.resolveModel.mockImplementation(async () => {
      if (++resolutions === 1) { entered(); await held; }
      return { providerId: 'test', modelId: 'model', runtimeRevision: 1 };
    });
    const pending = h.service.collect(input('https://docs.example/b', 'bing', 'q2', first.researchRunId),
      owner(), () => {});
    await resolving;
    try {
      await expect(h.service.collect(input('https://docs.example/c', 'bing', 'q3', first.researchRunId),
        owner(), () => {})).rejects.toThrow('already collecting');
    } finally { release(); await pending; }
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('persists an abort during model extraction as cancelled', async () => {
    const h = await harness();
    const controller = new AbortController();
    h.extract.mockImplementationOnce(async ({ sourceId }) => {
      controller.abort();
      return { sourceId, status: 'incomplete', reason: 'aborted', claims: [], evidence: [],
        examinedPassageIds: [], gaps: [] };
    });
    const result = await h.service.collect(input('https://docs.example/a', 'bing', 'q1'),
      owner(controller.signal), () => {});
    expect(result.sources[0].status).toBe('cancelled');
    const saved = await h.store.loadRun(threadId, result.researchRunId);
    expect(saved.sources[0].status).toBe('cancelled');
  });

  it('merges distinct requested URLs only after identical final URL and exact body hash are known', async () => {
    const h = await harness();
    const a = input('https://docs.example/old', 'bing', 'old');
    const b = input('https://mirror.example/new', 'duckduckgo', 'new');
    const combined = { ...a, enabledEngines: ['bing', 'duckduckgo'] as SearchEngineId[],
      attempts: [...a.attempts, ...b.attempts], discoveries: [...a.discoveries, ...b.discoveries] };
    h.fetch.mockImplementation(async ({ url, sourceId, budget }) => {
      const bytes = new TextEncoder().encode('same body');
      budget.reserveBytes(sourceId, bytes.length);
      return { requestedUrl: url, finalUrl: 'https://docs.example/final', redirectChain: [],
        status: 'readable', contentType: 'text/plain', bytes, receivedBytes: bytes.length };
    });
    const result = await h.service.collect(combined, owner(), () => {});
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.extract).toHaveBeenCalledTimes(1);
    const workerInput = h.extract.mock.calls[0][0];
    expect(workerInput.discoveries.map((item) => item.engineId).sort()).toEqual(['bing', 'duckduckgo']);
    expect(result.sources.filter((source) => source.status === 'completed')).toHaveLength(2);
  });

  it('keeps one canonical extraction when later URLs and alias discoveries reach the same body', async () => {
    const h = await harness();
    h.fetch.mockImplementation(async ({ url, sourceId, budget }) => {
      const bytes = new TextEncoder().encode('same body');
      budget.reserveBytes(sourceId, bytes.length);
      return { requestedUrl: url, finalUrl: 'https://docs.example/final', redirectChain: [],
        status: 'readable', contentType: 'text/plain', bytes, receivedBytes: bytes.length };
    });
    const first = await h.service.collect(input('https://docs.example/old', 'bing', 'q1'), owner(), () => {});
    await h.service.collect(input('https://mirror.example/new', 'duckduckgo', 'q2', first.researchRunId),
      owner(), () => {});
    expect(h.extract).toHaveBeenCalledTimes(2);
    let run = await h.store.loadRun(threadId, first.researchRunId);
    expect(run.sources.filter((source) => !source.aliasOf)).toHaveLength(1);
    expect(run.sources.find((source) => source.aliasOf)?.status).toBe('completed');
    await h.service.collect(input('https://mirror.example/new', 'google', 'q3', first.researchRunId),
      owner(), () => {});
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.extract).toHaveBeenCalledTimes(3);
    run = await h.store.loadRun(threadId, first.researchRunId);
    expect(run.sources.filter((source) => !source.aliasOf)).toHaveLength(1);
    expect(run.sources.find((source) => !source.aliasOf)?.discoveries.map((item) => item.engineId))
      .toEqual(['bing', 'duckduckgo', 'google']);
    expect(run.sources.map((source) => source.status)).toEqual(['completed', 'completed']);
    h.extract.mockImplementationOnce(async ({ sourceId }) => ({ sourceId, status: 'failed',
      reason: 'model_error', claims: [], evidence: [], examinedPassageIds: [], gaps: [] }));
    await h.service.collect(input('https://mirror.example/new', 'baidu', 'q4', first.researchRunId),
      owner(), () => {});
    run = await h.store.loadRun(threadId, first.researchRunId);
    expect(run.sources.map((source) => source.status)).toEqual(['completed', 'completed']);
    expect(run.sources.map((source) => source.reason)).toEqual(['reanalysis_model_error', 'reanalysis_model_error']);
    const saved = await h.store.loadSource(run, run.sources[0].sourceId);
    expect(saved.extraction?.status).toBe('irrelevant');
  });

  it('stops queue dispatch on abort and preserves already completed source status', async () => {
    const h = await harness();
    const controller = new AbortController();
    const first = input('https://docs.example/a', 'bing', 'q1');
    const second = input('https://docs.example/b', 'bing', 'q2');
    const third = input('https://docs.example/c', 'bing', 'q3');
    first.budget.fetchConcurrency = 1;
    const completed = await h.service.collect(first, owner(), () => {});
    const combined = { ...second, researchRunId: completed.researchRunId,
      attempts: [...second.attempts, ...third.attempts],
      discoveries: [...second.discoveries, ...third.discoveries],
      budget: { ...second.budget, fetchConcurrency: 1 } };
    const result = await h.service.collect(combined, owner(controller.signal), (event) => {
      if (event.status === 'extracting') controller.abort();
    });
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(result.sources.map((source) => source.status)).toEqual(['completed', 'cancelled', 'cancelled']);
  });

  it('passes abort to the in-flight fetch and does not start another queued URL', async () => {
    const h = await harness();
    const controller = new AbortController();
    const a = input('https://docs.example/a', 'bing', 'q1');
    const b = input('https://docs.example/b', 'bing', 'q2');
    a.budget.fetchConcurrency = 1;
    const combined = { ...a, attempts: [...a.attempts, ...b.attempts],
      discoveries: [...a.discoveries, ...b.discoveries] };
    let observedAbort = false;
    h.fetch.mockImplementationOnce(async ({ url, signal }) => {
      queueMicrotask(() => controller.abort());
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { observedAbort = signal.aborted; resolve(); }, { once: true });
      });
      return { requestedUrl: url, finalUrl: url, redirectChain: [], status: 'cancelled',
        reason: 'cancelled', bytes: new Uint8Array(), receivedBytes: 0 };
    });
    const pending = h.service.collect(combined, owner(controller.signal), () => {});
    const result = await pending;
    expect(observedAbort).toBe(true);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(result.sources.map((source) => source.status)).toEqual(['cancelled', 'cancelled']);
  });
});
