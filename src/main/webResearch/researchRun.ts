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
  publishedAt?: string;
  title?: string;
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

function newRecord(input: CollectInput, owner: CollectOwner): ResearchRunRecord {
  const now = new Date().toISOString();
  return { researchRunId: randomUUID(), threadId: owner.threadId, createdByRunId: owner.runId,
    continuationRunIds: [], originalQuestion: input.originalQuestion,
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
      : newRecord(input, owner);
    if (this.collecting.has(run.researchRunId)) throw new Error('research run already collecting');
    if (run.originalQuestion !== input.originalQuestion) throw new Error('research question changed');
    if (input.researchRunId && input.budgetOverrides) {
      for (const key of Object.keys(input.budgetOverrides) as Array<keyof ResearchBudget>) {
        const next = input.budgetOverrides[key];
        if (next !== undefined && next < run.budget[key]) throw new Error(`research budget cannot decrease: ${key}`);
      }
      Object.assign(run.budget, input.budgetOverrides);
    }
    this.collecting.add(run.researchRunId);
    let meter: ResearchBudgetMeter;
    try {
      if (input.researchRunId && !run.continuationRunIds.includes(owner.runId)) {
        run.continuationRunIds.push(owner.runId);
      }
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
    const syncAliases = async (canonical: SourceIndex): Promise<void> => {
      for (const alias of run.sources.filter((source) => source.aliasOf === canonical.sourceId)) {
        const saved = await store.loadSource(run, alias.sourceId);
        alias.status = canonical.status;
        alias.reason = canonical.reason;
        await store.saveSource(run, { ...saved, ...alias });
        emit(alias, 'persist');
      }
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
      const staged: Array<{ source: SourceIndex; body: BodyResult; previous?: SavedSource;
        forceExtract?: boolean }> = [];
      const changedCompleted = new Set<string>();
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
      // Search attempts and candidate URLs are facts already observed in IAB. Save them
      // before model preflight so a changed model cannot erase that work.
      await store.saveRun(run);
      const needsModel = input.discoveries.length > 0 || input.refresh ||
        run.sources.some((source) => source.status === 'interrupted' || source.pendingReanalysis);
      if (needsModel) {
        const activeModel = await this.deps.resolveModel(owner.threadId);
        if (run.modelSnapshot && (run.modelSnapshot.providerId !== activeModel.providerId ||
          run.modelSnapshot.modelId !== activeModel.modelId ||
          run.modelSnapshot.runtimeRevision !== activeModel.runtimeRevision)) throw new Error('model_changed');
        run.modelSnapshot ??= activeModel;
        await store.saveRun(run);
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
          const discoveries = appendNewDiscoveries(saved.discoveries, source.discoveries);
          const pendingReanalysis = discoveries.length > saved.discoveries.length || saved.pendingReanalysis;
          if (pendingReanalysis) changedCompleted.add(canonical.sourceId);
          canonical.discoveries = discoveries;
          canonical.pendingReanalysis = pendingReanalysis;
          await store.saveSource(run, { ...saved, discoveries, pendingReanalysis });
          continue;
        }
        if (input.refresh || input.discoveries.some((item) => candidateKey(item.resultUrl) === key) ||
          source.status === 'interrupted') {
          source.status = 'queued';
          delete source.aliasOf;
          tasks.push(source);
        }
      }
      await store.saveRun(run);
      for (const source of tasks) emit(source, 'collect');

      for (const sourceId of changedCompleted) {
        const saved = await store.loadSource(run, sourceId);
        if (!saved.contentHash || !saved.passages.length) throw new Error('completed source missing body');
        const current = run.sources.find((item) => item.sourceId === sourceId)!;
        staged.push({ source: current, body: { status: 'readable', passages: saved.passages,
          contentHash: saved.contentHash, completeness: saved.completeness ?? 'unknown' },
        previous: saved, forceExtract: true });
        emit({ ...current, status: 'extracting' }, 'extract');
      }

      const modelSnapshot = tasks.length || staged.length ? run.modelSnapshot : undefined;
      if ((tasks.length || staged.length) && !modelSnapshot) throw new Error('model_unavailable');
      let next = 0;
      const fetchWork = async () => {
        while (!owner.signal.aborted && next < tasks.length) {
          const source = tasks[next++];
          // A .pdf pathname is an explicit exclusion rule, not a MIME claim.
          // Unknown URL shapes are decided from the actual response instead.
          if (new URL(source.requestedUrl).pathname.toLowerCase().endsWith('.pdf')) {
            source.status = 'failed'; source.reason = 'pdf_url_excluded';
            await store.saveSource(run, { ...source, passages: [] });
            emit(source, 'persist');
            continue;
          }
          const previousSaved = await store.loadSource(run, source.sourceId).catch(() => undefined);
          const restorePrevious = async (reason: string): Promise<boolean> => {
            if (previousSaved?.status !== 'completed' || !previousSaved.extraction) return false;
            source.status = 'completed'; source.reason = `refresh_${reason}`;
            const discoveries = appendNewDiscoveries(previousSaved.discoveries, source.discoveries);
            const pendingReanalysis = previousSaved.pendingReanalysis ||
              discoveries.length > previousSaved.discoveries.length;
            await store.saveSource(run, { ...previousSaved, status: source.status, reason: source.reason,
              discoveries, pendingReanalysis });
            gaps.push(`${source.sourceId}: ${source.reason}`);
            emit(source, 'persist');
            return true;
          };
          const reserved = meter.reserveFetch(source.sourceId);
          if (!reserved.ok) {
            if (await restorePrevious(reserved.reason)) continue;
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
            source.redirectChain = fetched.redirectChain;
            source.statusCode = fetched.statusCode;
            source.contentType = fetched.contentType;
            source.canonicalUrl = fetched.canonicalUrl;
            source.assurance = fetched.assurance;
            source.receivedBytes = fetched.receivedBytes;
            if (fetched.status !== 'readable' || !fetched.finalUrl) {
              if (await restorePrevious(fetched.reason ?? fetched.status)) continue;
              source.status = fetched.status === 'cancelled' ? 'cancelled' : 'failed';
              source.reason = fetched.reason ?? fetched.status;
              await store.saveSource(run, { ...source, passages: [] }); emit(source, 'persist');
              continue;
            }
            const body = await this.deps.parse({ bytes: fetched.bytes, contentType: fetched.contentType,
              finalUrl: fetched.finalUrl, sourceId: source.sourceId });
            source.contentHash = body.contentHash;
            source.completeness = body.completeness;
            source.publishedAt = body.publishedAt;
            if (body.status !== 'readable' || !body.passages.length || !body.contentHash) {
              if (await restorePrevious(body.reason ?? body.status)) continue;
              source.status = 'failed'; source.reason = body.reason ?? body.status;
              await store.saveSource(run, { ...source, passages: body.passages }); emit(source, 'persist');
              continue;
            }
            const previous = previousSaved;
            source.status = 'extracting';
            await store.saveSource(run, { ...source, passages: body.passages,
              extraction: previous?.contentHash === body.contentHash ? previous.extraction : undefined });
            const forceExtract = previous && appendNewDiscoveries(previous.discoveries, source.discoveries)
              .length > previous.discoveries.length;
            staged.push({ source: run.sources.find((item) => item.sourceId === source.sourceId)!,
              body, previous, forceExtract });
            emit(source, 'extract');
          } catch (error) {
            if (error instanceof ResearchFixtureExhaustedError) throw error;
            if (await restorePrevious(owner.signal.aborted ? 'cancelled' : 'task_error')) continue;
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
            const forceExtract = group.some((item) => item.forceExtract);
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
                canonical = prior;
                const merged = appendNewDiscoveries(prior.discoveries, discoveries);
                const needsExtract = forceExtract || merged.length > prior.discoveries.length;
                extraction = needsExtract
                  ? await (this.deps.extract ?? extractSource)({ sourceId: prior.sourceId,
                    question: run.originalQuestion, angles: run.angles, discoveries: merged,
                    passages: saved.passages, completeness: saved.completeness ?? 'unknown',
                    modelSnapshot: modelSnapshot!, budget: meter, signal: owner.signal,
                    permits, adapter: this.deps.adapter })
                  : saved.extraction;
                prior.discoveries = merged;
                if (needsExtract) {
                  if (extraction.status === 'claims' || extraction.status === 'irrelevant') {
                    prior.status = 'completed'; prior.reason = undefined; prior.pendingReanalysis = false;
                  } else {
                    // The saved body is unchanged, so retain its last grounded extraction.
                    prior.status = 'completed'; prior.reason = `reanalysis_${extraction.reason ?? extraction.status}`;
                    prior.pendingReanalysis = true;
                    gaps.push(`${prior.sourceId}: ${prior.reason}`);
                    extraction = saved.extraction;
                  }
                }
                await store.saveSource(run, { ...saved, ...prior, extraction });
                if (needsExtract) emit(prior, 'persist');
              } else {
                leader.discoveries = appendNewDiscoveries(leader.discoveries, discoveries);
                const previous = group[0].previous;
                if (!forceExtract && previous && previous.contentHash === body.contentHash && previous.extraction) {
                  extraction = previous.extraction;
                }
                else extraction = await (this.deps.extract ?? extractSource)({ sourceId: leader.sourceId,
                  question: run.originalQuestion, angles: run.angles, discoveries: leader.discoveries,
                  passages: body.passages, completeness: body.completeness,
                  modelSnapshot: modelSnapshot!, budget: meter, signal: owner.signal, permits, adapter: this.deps.adapter });
                if (previous?.extraction && previous.contentHash === body.contentHash &&
                  extraction.status !== 'claims' && extraction.status !== 'irrelevant') {
                  leader.status = 'completed';
                  leader.reason = `reanalysis_${extraction.reason ?? extraction.status}`;
                  leader.pendingReanalysis = true;
                  gaps.push(`${leader.sourceId}: ${leader.reason}`);
                  extraction = previous.extraction;
                } else {
                  leader.status = owner.signal.aborted || extraction.reason === 'aborted' ? 'cancelled'
                    : extraction.status === 'claims' || extraction.status === 'irrelevant' ? 'completed' : 'failed';
                  leader.reason = leader.status === 'cancelled' ? 'aborted' : extraction.reason;
                  leader.pendingReanalysis = false;
                }
                await store.saveSource(run, { ...leader, passages: body.passages, extraction });
                emit(leader, 'persist');
              }
              for (const item of group) {
                if (item.source.sourceId === canonical.sourceId) continue;
                item.source.status = canonical.status;
                item.source.aliasOf = canonical.sourceId;
                item.source.reason = canonical.reason;
                await store.saveSource(run, { ...item.source, passages: item.body.passages });
                emit(item.source, 'persist');
              }
              await syncAliases(canonical);
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
        const taskIds = new Set([...tasks, ...staged.map((item) => item.source)]
          .map((source) => source.sourceId));
        for (const source of run.sources) if (taskIds.has(source.sourceId) &&
          (source.status === 'queued' || source.status === 'extracting')) {
          if (source.status === 'queued') {
            const saved = await store.loadSource(run, source.sourceId).catch(() => undefined);
            if (saved?.status === 'completed') {
              source.status = 'completed'; source.reason = 'refresh_cancelled';
              const discoveries = appendNewDiscoveries(saved.discoveries, source.discoveries);
              await store.saveSource(run, { ...saved, status: source.status, reason: source.reason,
                discoveries, pendingReanalysis: saved.pendingReanalysis ||
                  discoveries.length > saved.discoveries.length });
              gaps.push(`${source.sourceId}: ${source.reason}`);
              emit(source, 'persist');
              continue;
            }
          }
          const previous = staged.find((item) => item.source.sourceId === source.sourceId)?.previous;
          if (previous?.status === 'completed' && previous.extraction &&
            previous.contentHash === source.contentHash) {
            source.status = 'completed'; source.reason = 'reanalysis_aborted';
            source.pendingReanalysis = true;
            await store.saveSource(run, { ...previous, ...source, passages: previous.passages,
              extraction: previous.extraction });
            await syncAliases(source);
            gaps.push(`${source.sourceId}: ${source.reason}`);
            emit(source, 'persist');
            continue;
          }
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
