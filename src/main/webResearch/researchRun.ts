import { randomUUID } from 'node:crypto';
import type { CollectInput, Discovery, Passage, ResearchBudget, ResearchUsage, SearchAttempt,
  SourceExtraction } from '../../shared/webResearch';
import { ResearchBudgetMeter } from './budget';
import type { FetchResult } from './fetchSource';
import { extractSource, ModelPermitPool, ResearchFixtureExhaustedError,
  type ExtractSourceInput, type ModelAdapter, type ModelSnapshot } from './extractClaims';
import { summarizeAngles, type AngleSummary } from './summarizeAngles';
import { candidateKey } from './urlIdentity';
import { RunStore, type ResearchRunRecord, type SavedSource, type SourceIndex, type SourceStatus } from './runStore';

export type BodyResult = {
  status: 'readable' | 'unreadable' | 'needs_browser' | 'unsupported_media';
  passages: Passage[];
  contentHash?: string;
  completeness: 'complete' | 'truncated' | 'unknown';
  reason?: string;
};
export type Progress = {
  researchRunId: string;
  taskId: string;
  stage: 'collect' | 'fetch' | 'extract' | 'persist';
  status: SourceStatus;
  budget: ResearchBudget;
  usage: ResearchUsage;
};
export type CollectResult = {
  researchRunId: string;
  angles: AngleSummary[];
  sources: Array<Pick<SourceIndex, 'sourceId' | 'requestedUrl' | 'finalUrl' | 'status' | 'reason'>>;
  attempts: SearchAttempt[];
  budget: ResearchBudget;
  usage: ResearchUsage;
  gaps: string[];
};
export type CollectOwner = { threadId: string; runId: string; toolCallId: string; signal: AbortSignal };
export type ResearchRunDeps = {
  store: RunStore;
  fetch: (input: { url: string; sourceId: string; budget: ResearchBudgetMeter;
    signal: AbortSignal; preReserved: true }) => Promise<FetchResult>;
  parse: (input: { bytes: Uint8Array; contentType?: string; finalUrl: string; sourceId: string }) => Promise<BodyResult>;
  extract?: (input: ExtractSourceInput) => Promise<SourceExtraction>;
  resolveModel: (threadId: string) => Promise<ModelSnapshot>;
  adapter: ModelAdapter;
};

function newRecord(input: CollectInput, threadId: string): ResearchRunRecord {
  const now = new Date().toISOString();
  return { researchRunId: randomUUID(), threadId, originalQuestion: input.originalQuestion,
    createdAt: now, updatedAt: now, angles: [], enabledEngines: [], attempts: [], candidates: [],
    budget: input.budget, usage: { candidates: 0, fetchesDispatched: 0, receivedBytes: 0, modelCalls: 0 }, sources: [] };
}

function appendNewDiscoveries(existing: Discovery[], incoming: readonly Discovery[]): Discovery[] {
  const seen = new Set(existing.map((item) => JSON.stringify(item)));
  const result = [...existing];
  for (const item of incoming) {
    const identity = JSON.stringify(item);
    if (!seen.has(identity)) { result.push(item); seen.add(identity); }
  }
  return result;
}

/** One run's queue and budget live in main, never in the agent conversation. */
export class ResearchRunService {
  private readonly collecting = new Set<string>();
  constructor(private readonly deps: ResearchRunDeps) {}

  async collect(input: CollectInput, owner: CollectOwner, onProgress: (event: Progress) => void): Promise<CollectResult> {
    const store = this.deps.store;
    const run = input.researchRunId
      ? await store.loadRun(owner.threadId, input.researchRunId)
      : newRecord(input, owner.threadId);
    if (this.collecting.has(run.researchRunId)) throw new Error('research run already collecting');
    if (run.originalQuestion !== input.originalQuestion) throw new Error('research question changed');
    if (input.researchRunId && input.budgetOverrides) Object.assign(run.budget, input.budgetOverrides);
    this.collecting.add(run.researchRunId);
    let meter: ResearchBudgetMeter;
    try {
      if (input.researchRunId) store.activateRun(run.researchRunId);
      else await store.createRun(run);
      meter = new ResearchBudgetMeter(run.budget);
      meter.restore(run.usage, run.candidates.map((candidate) => candidate.requestedUrl),
        run.sources.filter((source) => source.receivedBytes !== undefined)
          .map((source) => [source.sourceId, source.receivedBytes!] as const));
    } catch (error) {
      store.closeRun(run.researchRunId);
      this.collecting.delete(run.researchRunId);
      throw error;
    }
    run.usage = meter.usage;
    const permits = new ModelPermitPool(run.budget.modelConcurrency);
    const gaps: string[] = [];
    const emit = (source: SourceIndex, stage: Progress['stage']) => {
      try {
        onProgress({ researchRunId: run.researchRunId, taskId: source.sourceId, stage,
          status: source.status, budget: { ...run.budget }, usage: { ...meter.usage } });
      } catch { /* progress observers cannot change persisted research state */ }
    };

    try {
      for (const angle of input.angles) {
        const prior = run.angles.find((item) => item.id === angle.id);
        // ReAct may issue a new query for the same angle; attempt.query preserves each actual search.
        if (prior && (prior.label !== angle.label || prior.rationale !== angle.rationale)) {
          throw new Error('research angle changed');
        }
        if (!prior) run.angles.push(angle);
      }
      for (const engine of input.enabledEngines) if (!run.enabledEngines.includes(engine)) run.enabledEngines.push(engine);
      for (const attempt of input.attempts) {
        const prior = run.attempts.find((item) => item.attemptId === attempt.attemptId);
        if (prior && JSON.stringify(prior) !== JSON.stringify(attempt)) throw new Error('search attempt changed');
        if (!prior) run.attempts.push(attempt);
      }
      // Persist failed or blocked search attempts even when there are no candidate URLs.
      await store.saveRun(run);

      const tasks: SourceIndex[] = [];
      for (const discovery of input.discoveries) {
        const key = candidateKey(discovery.resultUrl);
        let candidate = run.candidates.find((item) => candidateKey(item.requestedUrl) === key);
        if (!candidate) {
          const reserved = meter.reserveCandidate(discovery.resultUrl);
          if (!reserved.ok) { gaps.push(reserved.reason); continue; }
          candidate = { requestedUrl: discovery.resultUrl, discoveries: [] };
          run.candidates.push(candidate);
        }
        candidate.discoveries = appendNewDiscoveries(candidate.discoveries, [discovery]);
      }
      for (const candidate of run.candidates) {
        const key = candidateKey(candidate.requestedUrl);
        let source = run.sources.find((item) => candidateKey(item.requestedUrl) === key);
        if (!source) {
          source = { sourceId: randomUUID(), requestedUrl: candidate.requestedUrl,
            discoveries: candidate.discoveries, status: 'queued' };
          run.sources.push(source);
          tasks.push(source);
          continue;
        }
        source.discoveries = appendNewDiscoveries(source.discoveries, candidate.discoveries);
        if (source.status === 'completed' && !input.refresh) {
          const canonical = source.aliasOf
            ? run.sources.find((item) => item.sourceId === source.aliasOf) : source;
          if (!canonical) throw new Error('missing canonical source');
          const saved = await store.loadSource(run, canonical.sourceId);
          await store.saveSource(run, { ...saved,
            discoveries: appendNewDiscoveries(saved.discoveries, source.discoveries) });
          continue;
        }
        if (input.discoveries.some((item) => candidateKey(item.resultUrl) === key) ||
          source.status === 'interrupted') {
          source.status = 'queued';
          delete source.aliasOf;
          tasks.push(source);
        }
      }
      await store.saveRun(run);
      for (const source of tasks) emit(source, 'collect');

      const modelSnapshot = tasks.length ? await this.deps.resolveModel(owner.threadId) : undefined;
      const staged: Array<{ source: SourceIndex; body: BodyResult; previous?: SavedSource }> = [];
      let next = 0;
      const fetchWork = async () => {
        while (!owner.signal.aborted && next < tasks.length) {
          const source = tasks[next++];
          const reserved = meter.reserveFetch();
          if (!reserved.ok) {
            source.status = reserved.reason === 'cancelled' ? 'cancelled' : 'failed';
            source.reason = reserved.reason;
            await store.saveRun(run); emit(source, 'fetch');
            continue;
          }
          source.status = 'fetching'; source.reason = undefined;
          await store.saveRun(run); emit(source, 'fetch');
          try {
            if (owner.signal.aborted) {
              source.status = 'cancelled'; source.reason = 'cancelled';
              await store.saveRun(run); emit(source, 'persist');
              continue;
            }
            const fetched = await this.deps.fetch({ url: source.requestedUrl, sourceId: source.sourceId,
              budget: meter, signal: owner.signal, preReserved: true });
            source.finalUrl = fetched.finalUrl;
            source.receivedBytes = fetched.receivedBytes;
            if (fetched.status !== 'readable' || !fetched.finalUrl) {
              source.status = fetched.status === 'cancelled' ? 'cancelled' : 'failed';
              source.reason = fetched.reason ?? fetched.status;
              await store.saveSource(run, { ...source, passages: [] }); emit(source, 'persist');
              continue;
            }
            const body = await this.deps.parse({ bytes: fetched.bytes, contentType: fetched.contentType,
              finalUrl: fetched.finalUrl, sourceId: source.sourceId });
            source.contentHash = body.contentHash;
            source.completeness = body.completeness;
            if (body.status !== 'readable' || !body.passages.length || !body.contentHash) {
              source.status = 'failed'; source.reason = body.reason ?? body.status;
              await store.saveSource(run, { ...source, passages: body.passages }); emit(source, 'persist');
              continue;
            }
            const previous = await store.loadSource(run, source.sourceId).catch(() => undefined);
            source.status = 'extracting';
            await store.saveSource(run, { ...source, passages: body.passages });
            staged.push({ source: run.sources.find((item) => item.sourceId === source.sourceId)!, body, previous });
            emit(source, 'extract');
          } catch (error) {
            if (error instanceof ResearchFixtureExhaustedError) throw error;
            source.status = owner.signal.aborted ? 'cancelled' : 'failed';
            source.reason = owner.signal.aborted ? 'cancelled' : 'task_error';
            await store.saveSource(run, { ...source, passages: [] });
            emit(source, 'persist');
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(run.budget.fetchConcurrency, tasks.length) }, () => fetchWork()));
      if (!owner.signal.aborted) {
        const groups = new Map<string, typeof staged>();
        for (const item of staged) {
          // A truncated body hash only describes the prefix and cannot prove two full pages match.
          const identity = item.body.completeness === 'complete'
            ? `${item.source.finalUrl}\u0000${item.body.contentHash}` : item.source.sourceId;
          const group = groups.get(identity) ?? [];
          group.push(item);
          groups.set(identity, group);
        }
        const batches = [...groups.values()];
        let batchIndex = 0;
        const extractWork = async () => {
          while (!owner.signal.aborted && batchIndex < batches.length) {
            const group = batches[batchIndex++];
            const leader = group[0].source;
            const body = group[0].body;
            const prior = run.sources.find((source) => source.sourceId !== leader.sourceId &&
              source.status === 'completed' && !source.aliasOf && source.finalUrl === leader.finalUrl &&
              source.contentHash === leader.contentHash && source.completeness === 'complete');
            const discoveries = group.reduce((all, item) => appendNewDiscoveries(all, item.source.discoveries),
              [] as Discovery[]);
            try {
              let canonical = leader;
              let extraction: SourceExtraction;
              if (prior) {
                const saved = await store.loadSource(run, prior.sourceId);
                if (!saved.extraction) throw new Error('missing canonical extraction');
                extraction = saved.extraction;
                canonical = prior;
                prior.discoveries = appendNewDiscoveries(prior.discoveries, discoveries);
                await store.saveSource(run, { ...saved, discoveries: prior.discoveries });
              } else {
                leader.discoveries = appendNewDiscoveries(leader.discoveries, discoveries);
                const previous = group[0].previous;
                if (previous && previous.contentHash === body.contentHash && previous.extraction) {
                  extraction = previous.extraction;
                }
                else extraction = await (this.deps.extract ?? extractSource)({ sourceId: leader.sourceId,
                  question: run.originalQuestion, angles: run.angles, discoveries: leader.discoveries,
                  passages: body.passages, completeness: body.completeness,
                  modelSnapshot: modelSnapshot!, budget: meter, signal: owner.signal, permits, adapter: this.deps.adapter });
                leader.status = extraction.status === 'claims' || extraction.status === 'irrelevant' ? 'completed' : 'failed';
                leader.reason = extraction.reason;
                await store.saveSource(run, { ...leader, passages: body.passages, extraction });
                emit(leader, 'persist');
              }
              for (const item of group) {
                if (item.source.sourceId === canonical.sourceId) continue;
                item.source.status = canonical.status;
                item.source.aliasOf = canonical.sourceId;
                item.source.reason = canonical.reason;
                emit(item.source, 'persist');
              }
              await store.saveRun(run);
            } catch (error) {
              if (error instanceof ResearchFixtureExhaustedError) throw error;
              for (const item of group) {
                item.source.status = owner.signal.aborted ? 'cancelled' : 'failed';
                item.source.reason = owner.signal.aborted ? 'cancelled' : 'task_error';
                await store.saveRun(run); emit(item.source, 'persist');
              }
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(run.budget.modelConcurrency, batches.length) }, () => extractWork()));
      }
      if (owner.signal.aborted) {
        meter.cancel();
        const taskIds = new Set(tasks.map((source) => source.sourceId));
        for (const source of run.sources) if (taskIds.has(source.sourceId) &&
          (source.status === 'queued' || source.status === 'extracting')) {
          source.status = 'cancelled'; source.reason = 'cancelled'; emit(source, 'collect');
        }
        await store.saveRun(run);
      }
      const extractions: SourceExtraction[] = [];
      for (const source of run.sources) {
        if (source.status !== 'completed' || source.aliasOf) continue;
        const saved: SavedSource = await store.loadSource(run, source.sourceId);
        if (saved.extraction) extractions.push(saved.extraction);
      }
      return { researchRunId: run.researchRunId, angles: summarizeAngles(run.angles, extractions),
        sources: run.sources.map(({ sourceId, requestedUrl, finalUrl, status, reason }) =>
          ({ sourceId, requestedUrl, finalUrl, status, reason })),
        attempts: run.attempts, budget: run.budget, usage: { ...meter.usage }, gaps };
    } finally {
      await store.saveRun(run);
      store.closeRun(run.researchRunId);
      this.collecting.delete(run.researchRunId);
    }
  }
}
