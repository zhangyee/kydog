import { randomUUID } from 'node:crypto';
import type { Discovery, ResearchAngle, ResearchBudget, SourceExtraction } from '../../shared/webResearch';
import { DEFAULT_WEB_RESEARCH_TASK_BUDGET, type WebResearchTaskRecord,
  type WebResearchTaskSnapshot, type WebResearchTaskSource,
  type SearchObservation, type ObservationSelection,
  type ObservationSubmitDetail, type SearchObservationSummary } from '../../shared/webResearchTask';
import { ResearchBudgetMeter } from './budget';
import { candidateKey } from './urlIdentity';
import { extractSource, ModelPermitPool, type ExtractSourceInput, type ModelAdapter,
  type ModelSnapshot } from './extractClaims';
import type { BodyResult } from './researchRun';
import type { FetchResult } from './fetchSource';
import { TaskStore } from './taskStore';
import { completeReport, evidencePublicationState, validateReportCitations,
  type ReportValidationError } from './report';
import { resolveSourceUrls } from './sourceUrl';
import { buildTaskSnapshot as snapshot } from './taskState';

export type TaskSubmitInput = {
  researchRunId?: string;
  originalQuestion?: string;
  angles?: ResearchAngle[];
  observationIds?: string[];
  observationSelections?: ObservationSelection[];
  budget?: Partial<ResearchBudget>;
};
export type TaskOwner = { threadId: string; runId: string; projectRoot: string };
export type TaskInspectInput = { view: 'overview' | 'sources' | 'claims' | 'evidence';
  cursor?: string; pageSize?: number; angleId?: string; status?: WebResearchTaskSource['status'];
  evidenceIds?: string[] };
export type TaskInspectResult = { snapshot: WebResearchTaskSnapshot; items: unknown[]; nextCursor?: string };
export type TaskSubmitResult = { researchRunId: string; created: boolean; accepted: number;
  duplicates: number; unresolved: number; rejected: number;
  observationResults: ObservationSubmitDetail[]; snapshot: WebResearchTaskSnapshot };
export type TaskCompleteResult =
  | { completed: false; validationErrors: ReportValidationError[]; snapshot: WebResearchTaskSnapshot }
  | { completed: true; reportPath: string; snapshot: WebResearchTaskSnapshot };

export type TaskDeps = {
  store: TaskStore;
  fetch: (input: { url: string; sourceId: string; budget: ResearchBudgetMeter;
    signal: AbortSignal; preReserved: true }) => Promise<FetchResult>;
  fetchIcon?: (url: string, signal: AbortSignal) => Promise<string | undefined>;
  parse: (input: { bytes: Uint8Array; contentType?: string; finalUrl: string; sourceId: string }) => Promise<BodyResult>;
  extract?: (input: ExtractSourceInput) => Promise<SourceExtraction>;
  resolveModel: (threadId: string) => Promise<ModelSnapshot>;
  adapter: ModelAdapter;
  onUpdate: (snapshot: WebResearchTaskSnapshot) => void;
};

type Runtime = { task: WebResearchTaskRecord; sources: Map<string, WebResearchTaskSource>;
  meter: ResearchBudgetMeter; permits: ModelPermitPool; controller: AbortController;
  work?: Promise<void>; pending: boolean; finalizing?: boolean };

const SITE_ICON_CACHE_LIMIT = 64;
const SITE_ICON_TIMEOUT_MS = 5_000;

function isHttpUrl(raw: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(raw).protocol); } catch { return false; }
}
function resolvedHttpUrl(raw: string, base: string): string | undefined {
  try {
    const url = new URL(raw, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}
function nonempty(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`);
  return value.trim();
}
function page(input: TaskInspectInput): { offset: number; size: number } {
  const offset = input.cursor === undefined ? 0 : Number(input.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid cursor');
  const size = input.pageSize ?? 20;
  if (!Number.isSafeInteger(size) || size < 1 || size > 50) throw new Error('invalid pageSize');
  return { offset, size };
}
function sorted(sources: Iterable<WebResearchTaskSource>): WebResearchTaskSource[] {
  return [...sources].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sourceId.localeCompare(b.sourceId));
}

/** The agent coordinates research; this service only performs durable source work. */
export class WebResearchTaskService {
  private readonly active = new Map<string, Runtime>();
  private readonly loading = new Map<string, Promise<Runtime>>();
  private readonly iconCache = new Map<string, string>();
  private readonly iconInflight = new Map<string, Promise<string | undefined>>();
  constructor(private readonly deps: TaskDeps) {}
  private key(threadId: string, researchRunId: string): string { return `${threadId}/${researchRunId}`; }
  private async runtime(threadId: string, researchRunId: string): Promise<Runtime> {
    const key = this.key(threadId, researchRunId);
    const existing = this.active.get(key);
    if (existing) return existing;
    const loading = this.loading.get(key);
    if (loading) return loading;
    const request = this.loadRuntime(threadId, researchRunId, key);
    this.loading.set(key, request);
    try { return await request; }
    finally { if (this.loading.get(key) === request) this.loading.delete(key); }
  }
  private async loadRuntime(threadId: string, researchRunId: string, key: string): Promise<Runtime> {
    const task = await this.deps.store.loadTask(threadId, researchRunId);
    const all = await this.deps.store.listSources(task);
    const meter = new ResearchBudgetMeter(task.budget);
    const savedBytes = all.reduce((sum, source) => sum + (source.receivedBytes ?? 0), 0);
    const dispatchedSources = all.filter((source) => source.status === 'fetching' ||
      source.finalUrl !== undefined || source.receivedBytes !== undefined).length;
    const repairedUsage = { ...task.usage, candidates: all.length,
      fetchesDispatched: Math.max(task.usage.fetchesDispatched, dispatchedSources),
      receivedBytes: Math.max(task.usage.receivedBytes, savedBytes) };
    meter.restore(repairedUsage, all.map((source) => source.requestedUrl),
      all.filter((source) => source.receivedBytes !== undefined)
        .map((source) => [source.sourceId, source.receivedBytes!] as const));
    if (Object.entries(repairedUsage).some(([name, value]) =>
      value !== task.usage[name as keyof typeof repairedUsage])) {
      task.usage = repairedUsage;
      task.revision++;
      task.updatedAt = new Date().toISOString();
      await this.deps.store.saveTask(task);
    }
    const runtime: Runtime = { task, sources: new Map(all.map((source) => [candidateKey(source.requestedUrl), source])),
      meter, permits: new ModelPermitPool(task.budget.modelConcurrency), controller: new AbortController(),
      pending: false };
    this.active.set(key, runtime);
    if (task.status === 'running') {
      for (const source of all) {
        if (source.status === 'fetching' || source.status === 'extracting') {
          source.status = 'queued'; source.reason = 'interrupted';
          await this.deps.store.saveSource(task, source);
        }
      }
      this.kick(runtime);
    }
    return runtime;
  }
  private async changed(runtime: Runtime): Promise<WebResearchTaskSnapshot> {
    const { task, meter } = runtime;
    task.revision++;
    task.updatedAt = new Date().toISOString();
    task.usage = { ...meter.usage };
    await this.deps.store.saveTask(task);
    const value = snapshot(task, runtime.sources.values());
    try { this.deps.onUpdate(value); } catch { /* UI observers cannot alter persisted state */ }
    return value;
  }
  private async saveSource(runtime: Runtime, source: WebResearchTaskSource): Promise<void> {
    source.updatedAt = new Date().toISOString();
    await this.deps.store.saveSource(runtime.task, source);
    await this.changed(runtime);
  }

  async submit(input: TaskSubmitInput, owner: TaskOwner): Promise<TaskSubmitResult> {
    if (!input || typeof input !== 'object') throw new Error('invalid submit');
    if (input.observationIds && (!Array.isArray(input.observationIds) ||
      input.observationIds.some((id) => typeof id !== 'string'))) throw new Error('invalid observationIds');
    const observationSelections = input.observationSelections ?? [];
    if (!Array.isArray(observationSelections) || observationSelections.some((selection) =>
      !selection || typeof selection.observationId !== 'string' || !Array.isArray(selection.resultIndexes) ||
      !selection.resultIndexes.length || selection.resultIndexes.some((index) =>
        !Number.isSafeInteger(index) || index < 0) ||
      new Set(selection.resultIndexes).size !== selection.resultIndexes.length)) {
      throw new Error('invalid observation result indexes');
    }
    if (new Set(observationSelections.map((selection) => selection.observationId)).size !==
      observationSelections.length) throw new Error('duplicate observation selection');
    const compatibilityIds = [...new Set(input.observationIds ?? [])];
    const selectedIds = new Set(observationSelections.map((selection) => selection.observationId));
    if (compatibilityIds.some((id) => selectedIds.has(id))) {
      throw new Error('observationIds and observationSelections overlap');
    }
    for (const angle of input.angles ?? []) {
      if (!angle.id?.trim() || !angle.label?.trim() || !angle.query?.trim()) throw new Error('invalid angle');
    }
    if (new Set((input.angles ?? []).map((angle) => angle.id)).size !== (input.angles ?? []).length)
      throw new Error('duplicate angle');
    let preloadedObservations: SearchObservation[] | undefined;
    if (!input.researchRunId) {
      preloadedObservations = await Promise.all([...new Set([
        ...compatibilityIds, ...observationSelections.map((selection) => selection.observationId),
      ])]
        .map((id) => this.deps.store.loadObservation(owner.threadId, id)));
      const byId = new Map(preloadedObservations.map((observation) => [observation.observationId, observation]));
      for (const selection of observationSelections) {
        const observation = byId.get(selection.observationId)!;
        if (selection.resultIndexes.some((index) => index >= observation.rows.length)) {
          throw new Error('observation result index out of range');
        }
      }
      for (const observation of preloadedObservations) {
        if (!observation.angleIds.length || observation.angleIds.some((id) =>
          !input.angles?.some((angle) => angle.id === id))) throw new Error('observation angle unknown');
        if (!isHttpUrl(observation.searchPageUrl)) throw new Error('invalid search page URL');
      }
    }
    let runtime: Runtime;
    let created = false;
    if (input.researchRunId) {
      runtime = await this.runtime(owner.threadId, input.researchRunId);
      if (runtime.finalizing) throw new Error('task is completing');
      if (runtime.task.projectRoot !== owner.projectRoot) throw new Error('project changed');
      if (runtime.task.status === 'completed' || runtime.task.status === 'cancelled') throw new Error('task is closed');
      if (input.originalQuestion && input.originalQuestion !== runtime.task.originalQuestion) throw new Error('question changed');
    } else {
      const question = nonempty(input.originalQuestion, 'originalQuestion');
      if (!input.angles?.length) throw new Error('angles are required');
      const budget = { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET, ...input.budget };
      for (const [key, value] of Object.entries(budget)) {
        if (!Number.isSafeInteger(value) || value < (key === 'maxRedirectsPerSource' ? 0 : 1))
          throw new Error(`invalid budget.${key}`);
      }
      const now = new Date().toISOString();
      const task: WebResearchTaskRecord = { researchRunId: randomUUID(), threadId: owner.threadId,
        createdByRunId: owner.runId, projectRoot: owner.projectRoot, originalQuestion: question,
        createdAt: now, updatedAt: now, revision: 1, status: 'running', angles: [], attempts: [],
        observationIds: [], observationSelections: [], deferredObservationIds: [], discoveryCount: 0, budget,
        usage: { candidates: 0, fetchesDispatched: 0,
          receivedBytes: 0, modelCalls: 0 } };
      await this.deps.store.createTask(task);
      runtime = { task, sources: new Map(), meter: new ResearchBudgetMeter(budget),
        permits: new ModelPermitPool(budget.modelConcurrency), controller: new AbortController(),
        pending: false };
      this.active.set(this.key(owner.threadId, task.researchRunId), runtime);
      created = true;
    }
    const task = runtime.task;
    for (const angle of input.angles ?? []) {
      const previous = task.angles.find((item) => item.id === angle.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(angle)) throw new Error('angle changed; use a new id');
    }
    if (input.budget && !created) {
      for (const [key, value] of Object.entries(input.budget) as Array<[keyof ResearchBudget, number]>) {
        if (!Number.isSafeInteger(value) || value < task.budget[key]) throw new Error(`budget cannot decrease: ${key}`);
      }
    }
    const idsToLoad = [...new Set([
      ...compatibilityIds, ...observationSelections.map((selection) => selection.observationId),
      ...(task.deferredObservationIds ?? []),
    ])];
    const loaded = new Map((preloadedObservations ??
      await Promise.all(idsToLoad.map((id) => this.deps.store.loadObservation(owner.threadId, id))))
      .map((observation) => [observation.observationId, observation]));
    const requestedSelections: ObservationSelection[] = [
      ...observationSelections.map((selection) => ({ observationId: selection.observationId,
        resultIndexes: [...selection.resultIndexes] })),
      ...compatibilityIds.map((observationId) => ({ observationId,
        resultIndexes: loaded.get(observationId)!.rows.map((_row, index) => index) })),
    ];
    const savedSelectionIds = new Set((task.observationSelections ?? []).map((selection) => selection.observationId));
    const savedSelections = new Map((task.observationSelections ?? [])
      .map((selection) => [selection.observationId, new Set(selection.resultIndexes)]));
    const processing = new Map<string, Set<number>>();
    let newlySelectedCount = 0;
    for (const selection of requestedSelections) {
      const prior = savedSelections.get(selection.observationId) ?? new Set<number>();
      const fresh = selection.resultIndexes.filter((index) => !prior.has(index));
      if (fresh.length || (!savedSelectionIds.has(selection.observationId) && !selection.resultIndexes.length)) {
        processing.set(selection.observationId, new Set(fresh));
        newlySelectedCount += fresh.length;
      }
    }
    for (const observationId of task.deferredObservationIds ?? []) {
      const indexes = savedSelections.get(observationId);
      if (indexes?.size) processing.set(observationId, new Set(indexes));
      else {
        const observation = loaded.get(observationId);
        if (observation) processing.set(observationId,
          new Set(observation.rows.map((_row, index) => index)));
      }
    }
    const processingSelections = [...processing].map(([observationId, indexes]) =>
      ({ observationId, resultIndexes: [...indexes].sort((a, b) => a - b) }));
    for (const selection of processingSelections) {
      const observation = loaded.get(selection.observationId);
      if (!observation || selection.resultIndexes.some((index) => index >= observation.rows.length)) {
        throw new Error('observation result index out of range');
      }
    }
    const observations = processingSelections.length
      ? await this.deps.store.lockObservationsForSubmit(owner.threadId, task.researchRunId, processingSelections)
      : [];
    for (const observation of observations) {
      if (!observation.angleIds.length || observation.angleIds.some((id) =>
        !task.angles.some((a) => a.id === id) && !input.angles?.some((a) => a.id === id)))
        throw new Error('observation angle unknown');
      if (!isHttpUrl(observation.searchPageUrl)) throw new Error('invalid search page URL');
    }
    for (const angle of input.angles ?? []) {
      if (!task.angles.some((item) => item.id === angle.id)) task.angles.push(angle);
    }
    for (const selection of requestedSelections) {
      let saved = task.observationSelections?.find((item) => item.observationId === selection.observationId);
      if (!saved) {
        saved = { observationId: selection.observationId, resultIndexes: [] };
        (task.observationSelections ??= []).push(saved);
      }
      const indexes = new Set(saved.resultIndexes);
      for (const index of selection.resultIndexes) indexes.add(index);
      saved.resultIndexes = [...indexes].sort((a, b) => a - b);
    }
    task.discoveryCount += newlySelectedCount;
    if (input.budget && !created) {
      Object.assign(task.budget, input.budget);
      runtime.permits.raiseLimit(task.budget.modelConcurrency);
    }
    let accepted = 0; let duplicates = 0; let unresolved = 0; let rejected = 0;
    const observationResults: ObservationSubmitDetail[] = [];
    const touched = new Set<WebResearchTaskSource>();
    for (const observation of observations) {
      const resultIndexes = processing.get(observation.observationId);
      if (!resultIndexes) continue;
      const detail: ObservationSubmitDetail = { observationId: observation.observationId,
        resultIndexes: [...resultIndexes].sort((a, b) => a - b), acceptedIndexes: [],
        duplicateIndexes: [], unresolvedIndexes: [], rejectedIndexes: [] };
      observationResults.push(detail);
      if (!task.observationIds.includes(observation.observationId)) {
        task.observationIds.push(observation.observationId);
        task.attempts.push({ attemptId: observation.attemptId, angleIds: observation.angleIds,
          engineId: observation.engineId, query: observation.query, searchPageUrl: observation.searchPageUrl,
          status: observation.status ?? (observation.rows.length ? 'results' : 'extraction_error'),
          ...(observation.failure ? { reason: observation.failure.message } : {}) });
      }
      let deferred = false;
      for (const [resultIndex, row] of observation.rows.entries()) {
        if (!resultIndexes.has(resultIndex)) continue;
        if (!resolvedHttpUrl(row.rawHref, observation.searchPageUrl)) {
          rejected++; detail.rejectedIndexes.push(resultIndex); continue;
        }
        if (!row.targetUrl) { unresolved++; detail.unresolvedIndexes.push(resultIndex); continue; }
        if (!isHttpUrl(row.targetUrl)) { rejected++; detail.rejectedIndexes.push(resultIndex); continue; }
        const key = candidateKey(row.targetUrl);
        let source = runtime.sources.get(key);
        if (!source) {
          const reservation = runtime.meter.reserveCandidate(row.targetUrl);
          if (!reservation.ok) {
            rejected++; detail.rejectedIndexes.push(resultIndex);
            deferred = reservation.reason === 'candidate_limit' || deferred;
            task.status = 'paused'; task.statusReason = reservation.reason; continue;
          }
          const now = new Date().toISOString();
          source = { sourceId: randomUUID(), requestedUrl: row.targetUrl, status: 'queued',
            createdAt: now, updatedAt: now, discoveries: [], passages: [] };
          runtime.sources.set(key, source);
          accepted++; detail.acceptedIndexes.push(resultIndex);
        } else { duplicates++; detail.duplicateIndexes.push(resultIndex); }
        for (const angleId of observation.angleIds) {
          const discovery: WebResearchTaskSource['discoveries'][number] = {
            attemptId: observation.attemptId, angleId, engineId: observation.engineId,
            query: observation.query, resultUrl: row.targetUrl, searchPageUrl: observation.searchPageUrl,
            title: row.title, snippet: row.snippet, rawHref: row.rawHref,
            observationId: observation.observationId, resultIndex };
          if (!source.discoveries.some((prior) => prior.observationId === discovery.observationId &&
            prior.resultIndex === discovery.resultIndex && prior.angleId === discovery.angleId)) {
            source.discoveries.push(discovery);
            if (source.status === 'completed' || source.status === 'extracting')
              source.pendingReanalysis = true;
          }
        }
        touched.add(source);
      }
      task.deferredObservationIds = (task.deferredObservationIds ?? [])
        .filter((id) => id !== observation.observationId);
      if (deferred) task.deferredObservationIds.push(observation.observationId);
    }
    await Promise.all([...touched].map((source) => this.deps.store.saveSource(task, source)));
    const current = await this.changed(runtime);
    this.kick(runtime);
    return { researchRunId: task.researchRunId, created, accepted, duplicates, unresolved, rejected,
      observationResults, snapshot: current };
  }

  private kick(runtime: Runtime): void {
    if (runtime.task.status !== 'running') return;
    if (runtime.work) { runtime.pending = true; return; }
    const tasks = sorted(runtime.sources.values()).filter((source) => source.status === 'queued' ||
      source.pendingReanalysis);
    if (!tasks.length) return;
    const count = Math.min(runtime.task.budget.fetchConcurrency, tasks.length);
    let next = 0;
    const worker = async () => {
      while (runtime.task.status === 'running' && !runtime.controller.signal.aborted && next < tasks.length) {
        const source = tasks[next++];
        await this.processSource(runtime, source);
      }
    };
    runtime.work = Promise.all(Array.from({ length: count }, worker)).then(() => undefined)
      .catch(async (error: unknown) => {
        runtime.task.status = 'failed';
        runtime.task.statusReason = error instanceof Error ? error.message : String(error);
        await this.changed(runtime);
      }).finally(() => {
        runtime.work = undefined;
        if (runtime.pending && runtime.task.status === 'running') {
          runtime.pending = false;
          this.kick(runtime);
        }
      });
  }

  private async processSource(runtime: Runtime, source: WebResearchTaskSource): Promise<void> {
    const { task, meter } = runtime;
    const signal = runtime.controller.signal;
    try {
      if (new URL(source.requestedUrl).pathname.toLowerCase().endsWith('.pdf')) {
        source.status = 'failed'; source.reason = 'pdf_url_excluded';
        await this.saveSource(runtime, source); return;
      }
      let passages = source.passages;
      if (!source.contentHash || !passages.length ||
        (!source.pendingReanalysis && source.reason !== 'interrupted')) {
        const reserved = meter.reserveFetch(source.sourceId);
        if (!reserved.ok) {
          task.status = 'paused'; task.statusReason = reserved.reason;
          await this.changed(runtime); return;
        }
        // Persist the reservation before dispatch: a crash must not make a sent fetch free.
        await this.changed(runtime);
        source.status = 'fetching'; source.reason = undefined;
        await this.saveSource(runtime, source);
        const resolvedUrls = resolveSourceUrls(source.requestedUrl);
        source.contentUrl = resolvedUrls.contentUrl;
        const fetched = await this.deps.fetch({ url: resolvedUrls.contentUrl, sourceId: source.sourceId,
          budget: meter, signal, preReserved: true });
        await this.changed(runtime);
        if (signal.aborted) { source.status = 'queued'; await this.saveSource(runtime, source); return; }
        source.contentFinalUrl = fetched.finalUrl;
        source.finalUrl = resolvedUrls.contentUrl === resolvedUrls.reportUrl
          ? fetched.finalUrl : resolvedUrls.reportUrl;
        source.redirectChain = fetched.redirectChain;
        source.contentType = fetched.contentType;
        source.statusCode = fetched.statusCode;
        source.receivedBytes = fetched.receivedBytes;
        if (fetched.reason === 'total_byte_limit') {
          source.status = 'queued'; source.reason = fetched.reason;
          task.status = 'paused'; task.statusReason = fetched.reason;
          await this.saveSource(runtime, source); return;
        }
        if (fetched.status !== 'readable' || !fetched.finalUrl) {
          source.status = 'failed'; source.reason = fetched.reason ?? fetched.status;
          await this.saveSource(runtime, source); return;
        }
        const body = await this.deps.parse({ bytes: fetched.bytes, contentType: fetched.contentType,
          finalUrl: fetched.finalUrl, sourceId: source.sourceId });
        source.passages = body.passages;
        source.contentHash = body.contentHash;
        source.completeness = body.completeness;
        source.siteIconUrl = body.siteIconUrl;
        passages = body.passages;
        if (body.status !== 'readable' || !passages.length || !source.contentHash) {
          source.status = 'failed'; source.reason = body.reason ?? body.status;
          await this.saveSource(runtime, source); return;
        }
      }
      if (signal.aborted) { source.status = 'queued'; await this.saveSource(runtime, source); return; }
      if (!task.modelSnapshot) {
        task.modelSnapshot = await this.deps.resolveModel(task.threadId);
        await this.changed(runtime);
      }
      source.status = 'extracting';
      source.pendingReanalysis = false;
      await this.saveSource(runtime, source);
      const discoveryCountAtExtraction = source.discoveries.length;
      const adapter: ModelAdapter = { currentRevision: () => this.deps.adapter.currentRevision(),
        complete: async (request) => { await this.changed(runtime); return this.deps.adapter.complete(request); } };
      const extraction = await (this.deps.extract ?? extractSource)({ sourceId: source.sourceId,
        question: task.originalQuestion, angles: task.angles, discoveries: source.discoveries as Discovery[],
        passages, completeness: source.completeness ?? 'unknown', modelSnapshot: task.modelSnapshot,
        budget: meter, signal, permits: runtime.permits, adapter });
      if (signal.aborted) {
        source.status = 'queued'; source.pendingReanalysis = true;
      } else if (extraction.reason === 'model_call_limit') {
        source.status = 'queued'; source.pendingReanalysis = true;
        task.status = 'paused'; task.statusReason = extraction.reason;
      } else {
        source.extraction = extraction;
        source.status = extraction.status === 'claims' || extraction.status === 'irrelevant' ? 'completed' : 'failed';
        source.reason = extraction.reason;
        source.pendingReanalysis = source.pendingReanalysis ||
          source.discoveries.length > discoveryCountAtExtraction;
      }
      await this.saveSource(runtime, source);
    } catch (error) {
      source.status = signal.aborted ? 'queued' : 'failed';
      source.reason = signal.aborted ? 'interrupted' :
        error instanceof Error ? error.message : 'source_error';
      await this.saveSource(runtime, source);
    }
  }

  async whenIdle(threadId: string, researchRunId: string): Promise<void> {
    const runtime = await this.runtime(threadId, researchRunId);
    while (runtime.work) await runtime.work;
  }

  async get(threadId: string, researchRunId: string): Promise<WebResearchTaskSnapshot> {
    const runtime = await this.runtime(threadId, researchRunId);
    return snapshot(runtime.task, runtime.sources.values());
  }

  /** Load one declared site icon outside the source-processing critical path. */
  async siteIcon(threadId: string, researchRunId: string, domain: string,
    timeoutMs = SITE_ICON_TIMEOUT_MS): Promise<string | undefined> {
    const runtime = await this.runtime(threadId, researchRunId);
    const normalized = domain.trim().toLowerCase();
    const source = sorted(runtime.sources.values()).find((candidate) => {
      if (!candidate.siteIconUrl) return false;
      try { return new URL(candidate.finalUrl ?? candidate.requestedUrl).hostname.toLowerCase() === normalized; }
      catch { return false; }
    });
    if (!source?.siteIconUrl || !this.deps.fetchIcon) return undefined;
    const cached = this.iconCache.get(source.siteIconUrl);
    if (cached) {
      this.iconCache.delete(source.siteIconUrl);
      this.iconCache.set(source.siteIconUrl, cached);
      return cached;
    }
    const existing = this.iconInflight.get(source.siteIconUrl);
    if (existing) return existing;
    const iconUrl = source.siteIconUrl;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(undefined); }, timeoutMs);
    });
    const fetch = this.deps.fetchIcon(iconUrl, controller.signal).catch(() => undefined);
    const request = Promise.race([fetch, timeout])
      .finally(() => {
        clearTimeout(timer);
        this.iconInflight.delete(iconUrl);
      });
    this.iconInflight.set(iconUrl, request);
    const value = await request;
    if (value) {
      this.iconCache.set(iconUrl, value);
      while (this.iconCache.size > SITE_ICON_CACHE_LIMIT) {
        const oldest = this.iconCache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.iconCache.delete(oldest);
      }
    }
    return value;
  }

  async list(threadId: string): Promise<WebResearchTaskSnapshot[]> {
    const tasks = await this.deps.store.listTasks(threadId);
    return Promise.all(tasks.map((task) => this.get(threadId, task.researchRunId)));
  }

  async inspect(threadId: string, researchRunId: string, input: TaskInspectInput): Promise<TaskInspectResult> {
    const runtime = await this.runtime(threadId, researchRunId);
    const current = snapshot(runtime.task, runtime.sources.values());
    if (input.view === 'overview') {
      const observations = await Promise.all(runtime.task.observationIds.map((observationId) =>
        this.deps.store.loadObservation(threadId, observationId)));
      const items: SearchObservationSummary[] = observations.map((observation) => ({
        observationId: observation.observationId,
        engineId: observation.engineId,
        query: observation.query,
        executionPath: observation.executionPath,
        status: observation.status,
        inputSubmitted: observation.inputSubmitted,
        navigationConfirmed: observation.navigationConfirmed,
        resultsExtracted: observation.resultsExtracted,
        executionFacts: observation.executionFacts,
        ...(observation.failure ? { failure: observation.failure } : {}),
        candidateCount: observation.rows.length,
        confirmedCount: observation.rows.filter((row) => row.targetUrl !== undefined).length,
        unresolvedCount: observation.rows.filter((row) => row.targetUrl === undefined).length,
      }));
      return { snapshot: current, items };
    }
    const { offset, size } = page(input);
    const sources = sorted(runtime.sources.values()).filter((source) =>
      (!input.status || source.status === input.status) &&
      (!input.angleId || source.discoveries.some((d) => d.angleId === input.angleId)));
    let items: unknown[];
    if (input.view === 'sources') {
      items = sources.map((source) => ({ sourceId: source.sourceId, requestedUrl: source.requestedUrl,
        contentUrl: source.contentUrl, contentFinalUrl: source.contentFinalUrl,
        finalUrl: source.finalUrl, status: source.status, reason: source.reason,
        discoveryCount: source.discoveries.length, discoveryPreview: source.discoveries.slice(0, 3),
        claimCount: source.extraction?.claims.length ?? 0,
        evidenceCount: source.extraction?.evidence.length ?? 0 }));
    } else if (input.view === 'claims') {
      items = sources.flatMap((source) => (source.extraction?.claims ?? [])
        .filter((claim) => !input.angleId || claim.relevantAngleIds.includes(input.angleId))
        .map((claim) => ({ ...claim, finalUrl: source.finalUrl, sourceStatus: source.status,
          evidence: source.extraction!.evidence.filter((e) => claim.evidenceIds.includes(e.evidenceId)) })));
    } else if (input.view === 'evidence') {
      if (!input.evidenceIds?.length || input.evidenceIds.length > 4) throw new Error('evidenceIds must contain 1–4 IDs');
      items = input.evidenceIds.map((id) => {
        for (const source of sources) {
          const evidence = source.extraction?.evidence.find((item) => item.evidenceId === id);
          if (!evidence) continue;
          const passage = source.passages.find((item) => item.passageId === evidence.passageId);
          const publication = evidencePublicationState(source, evidence);
          return { ...evidence, finalUrl: source.finalUrl, sourceStatus: source.status,
            publishable: publication.publishable, unavailableReason: publication.unavailableReason,
            excerpt: passage?.text.slice(0, 4000) ?? '',
            excerptTruncated: (passage?.text.length ?? 0) > 4000 };
        }
        throw new Error(`evidence not found: ${id}`);
      });
    } else throw new Error('invalid view');
    const selected = items.slice(offset, offset + size);
    return { snapshot: current, items: selected,
      nextCursor: offset + size < items.length ? String(offset + size) : undefined };
  }

  async control(threadId: string, researchRunId: string, action: 'pause' | 'resume' | 'cancel'):
    Promise<WebResearchTaskSnapshot> {
    const runtime = await this.runtime(threadId, researchRunId);
    if (runtime.finalizing) throw new Error('task is completing');
    if (runtime.task.status === 'completed' || runtime.task.status === 'cancelled') throw new Error('task is closed');
    if (action === 'resume') {
      runtime.task.status = 'running'; runtime.task.statusReason = undefined;
      runtime.controller = new AbortController();
      const value = await this.changed(runtime);
      this.kick(runtime);
      return value;
    }
    runtime.task.status = action === 'pause' ? 'paused' : 'cancelled';
    runtime.task.statusReason = action === 'pause' ? 'paused_by_user' : 'cancelled_by_user';
    runtime.controller.abort();
    if (action === 'cancel') {
      if (runtime.work) await runtime.work;
      for (const source of runtime.sources.values()) {
        if (source.status === 'queued') { source.status = 'cancelled'; await this.deps.store.saveSource(runtime.task, source); }
      }
    }
    return this.changed(runtime);
  }

  async complete(threadId: string, researchRunId: string, reportMarkdown: string,
    fileName?: string, unprocessedReason?: string): Promise<TaskCompleteResult> {
    const runtime = await this.runtime(threadId, researchRunId);
    if (runtime.finalizing) throw new Error('task is completing');
    if (runtime.task.status === 'completed' || runtime.task.status === 'cancelled') throw new Error('task is closed');
    const hasOutstanding = sorted(runtime.sources.values()).some((source) =>
      source.status === 'queued' || source.status === 'fetching' || source.status === 'extracting');
    if (hasOutstanding && !unprocessedReason?.trim()) throw new Error('unprocessedReason required');
    const beforeFinalizing = sorted(runtime.sources.values());
    const validation = validateReportCitations(beforeFinalizing, reportMarkdown, unprocessedReason);
    if (!validation.ok) return { completed: false, validationErrors: validation.errors,
      snapshot: snapshot(runtime.task, runtime.sources.values()) };
    const previousStatus = runtime.task.status;
    const previousStatusReason = runtime.task.statusReason;
    runtime.finalizing = true;
    try {
      runtime.task.status = 'paused';
      runtime.task.statusReason = 'finalizing_report';
      runtime.controller.abort();
      await this.changed(runtime);
      if (runtime.work) await runtime.work;
      const sources = sorted(runtime.sources.values());
      const queued = sources.filter((source) => source.status === 'queued');
      const report = await completeReport(runtime.task, sources, reportMarkdown, fileName,
        unprocessedReason);
      if (!report.completed) {
        runtime.task.status = previousStatus;
        runtime.task.statusReason = previousStatusReason;
        if (previousStatus === 'running') runtime.controller = new AbortController();
        const current = await this.changed(runtime);
        if (previousStatus === 'running') this.kick(runtime);
        return { completed: false, validationErrors: report.validationErrors, snapshot: current };
      }
      for (const source of queued) { source.status = 'unprocessed'; source.reason = unprocessedReason;
        await this.deps.store.saveSource(runtime.task, source); }
      runtime.task.reportPath = report.reportPath;
      runtime.task.unprocessedReason = unprocessedReason;
      runtime.task.status = 'completed';
      runtime.task.statusReason = undefined;
      const current = await this.changed(runtime);
      return { completed: true, reportPath: report.reportPath, snapshot: current };
    } catch (error) {
      runtime.task.status = 'paused';
      runtime.task.statusReason = error instanceof Error ? error.message : String(error);
      await this.changed(runtime);
      throw error;
    } finally {
      runtime.finalizing = false;
    }
  }
}
