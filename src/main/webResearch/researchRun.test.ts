import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CollectInput, Discovery, SearchEngineId } from '../../shared/webResearch';
import { DEFAULT_RESEARCH_BUDGET } from './budget';
import type { FetchResult } from './fetchSource';
import type { ExtractSourceInput } from './extractClaims';
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
  const extract = vi.fn(async ({ sourceId }: ExtractSourceInput) => ({ sourceId, status: 'irrelevant' as const,
    claims: [], evidence: [], examinedPassageIds: [`${sourceId}:p1`], gaps: [] }));
  const service = new ResearchRunService({ store, fetch, parse, extract,
    resolveModel: async () => ({ providerId: 'test', modelId: 'model', runtimeRevision: 1 }),
    adapter: { currentRevision: () => 1, complete: async () => ({ text: '', stopReason: 'stop' }) } });
  return { store, service, fetch, parse, extract, setBody: (value: string) => { currentBody = value; } };
}

describe('ResearchRunService', () => {
  it('merges batches and both engine discoveries while reusing a completed URL', async () => {
    const h = await harness();
    const first = await h.service.collect(input('https://docs.example/v2', 'bing', 'v2 protocol'), owner(), () => {});
    expect(first.sources).toHaveLength(1);
    const second = await h.service.collect(input('https://docs.example/v2', 'duckduckgo', 'v2 migration',
      first.researchRunId), owner(), () => {});
    expect(second.sources).toHaveLength(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.extract).toHaveBeenCalledTimes(1);
    const saved = await h.store.loadRun(threadId, first.researchRunId);
    expect(saved.attempts).toHaveLength(2);
    expect(saved.sources[0].discoveries.map((item) => item.engineId)).toEqual(['bing', 'duckduckgo']);
    expect(saved.usage.fetchesDispatched).toBe(1);
  });

  it('refreshes explicitly, reusing extraction only when the exact body hash matches', async () => {
    const h = await harness();
    const url = 'https://docs.example/v2';
    const first = await h.service.collect(input(url, 'bing', 'v2'), owner(), () => {});
    await h.service.collect(input(url, 'bing', 'v2 fresh', first.researchRunId, true), owner(), () => {});
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.extract).toHaveBeenCalledTimes(1);
    h.setBody('新版仍允许 HTTP。');
    await h.service.collect(input(url, 'bing', 'v2 changed', first.researchRunId, true), owner(), () => {});
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.extract).toHaveBeenCalledTimes(2);
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
