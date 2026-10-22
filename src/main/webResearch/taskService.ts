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
import { browserTrigger, isOutstandingSource, buildTaskSnapshot as snapshot } from './taskState';
import { BrowserDomBudget } from './browserDomBudget';
import type { BrowserReader, BrowserSourceKey, BrowserLeaseUnavailable, ResearchDocumentFacts } from './browserReadTypes';
import type { BrowserTrigger, BrowserReadAttempt } from '../../shared/webResearchTask';

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
  browserReader?: BrowserReader;
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
  work?: Promise<void>; pending: boolean; finalizing?: boolean; revoked?: boolean;
  controlWork?: Promise<unknown>; finalizationWork?: Promise<TaskCompleteResult>; openWork: Set<Promise<unknown>>; openIntents: Map<string, AbortController>;
  persistenceFailures: Set<unknown>; idleError?: unknown;
  domBudget: BrowserDomBudget; budgetTail: Promise<void>; sourceTails: Map<string, Promise<void>>;
  browserWork: Map<string, Promise<void>>; browserControllers: Map<string, AbortController>; browserLeases: Map<string, { attemptId: string | null; leaseId: string }>; };

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

function sameDocumentFacts(a: ResearchDocumentFacts, b: ResearchDocumentFacts): boolean {
  return a.url === b.url && a.rootRule === b.rootRule && a.utf8Bytes === b.utf8Bytes &&
    a.mainStatusCode === b.mainStatusCode && a.documentContentType === b.documentContentType &&
    a.identity.documentEpoch === b.identity.documentEpoch && a.identity.routeRevision === b.identity.routeRevision &&
    a.identity.navigationSequence === b.identity.navigationSequence;
}

/** The agent coordinates research; this service only performs durable source work. */
export class WebResearchTaskService {
  private readonly active = new Map<string, Runtime>();
  private readonly loading = new Map<string, Promise<Runtime>>();
  private readonly iconCache = new Map<string, string>();
  private readonly iconInflight = new Map<string, Promise<string | undefined>>();
  private stopped = false;
  private readonly disposedThreads = new Set<string>();
  private shutdownWork?: Promise<void>;
  private readonly submitting = new Map<string, Set<Promise<TaskSubmitResult>>>();
  private readonly disposing = new Map<string, Promise<void>>();
  private readonly offLease?: () => void;
  constructor(private readonly deps: TaskDeps) {
    this.offLease = deps.browserReader?.onLeaseUnavailable?.((event) => {
      const runtime = this.active.get(this.key(event.threadId, event.researchRunId));
      if (runtime) void this.leaseUnavailable(runtime, event).catch((error: unknown) => { runtime.idleError = error; });
    });
  }
  /** Task budget writes and source intents never enclose browser or model awaits. */
  private taskSerial<T>(runtime: Runtime, action: () => Promise<T>): Promise<T> {
    const result = runtime.budgetTail.then(action);
    runtime.budgetTail = result.then(() => {}, () => {});
    return result;
  }
  private sourceSerial<T>(runtime: Runtime, sourceId: string, action: () => Promise<T>): Promise<T> {
    const result = (runtime.sourceTails.get(sourceId) ?? Promise.resolve()).then(action);
    const tail = result.then(() => {}, () => {});
    runtime.sourceTails.set(sourceId, tail);
    void tail.then(() => { if (runtime.sourceTails.get(sourceId) === tail) runtime.sourceTails.delete(sourceId); });
    return result;
  }
  private source(runtime: Runtime, sourceId: string): WebResearchTaskSource | undefined {
    return [...runtime.sources.values()].find((source) => source.sourceId === sourceId);
  }
  private currentAttempt(runtime: Runtime, sourceId: string, attemptId: string): BrowserReadAttempt | undefined {
    const source = this.source(runtime, sourceId);
    const attempt = source?.browser?.attempts.at(-1);
    return runtime.task.status === 'running' && !runtime.revoked && !runtime.finalizing && !runtime.controller.signal.aborted &&
      (source?.status === 'browser_queued' || source?.status === 'browser_reading') &&
      attempt?.attemptId === attemptId ? attempt : undefined;
  }
  private async leaseUnavailable(runtime: Runtime, event: BrowserLeaseUnavailable): Promise<void> {
    await this.sourceSerial(runtime, event.sourceId, async () => {
      const lease = runtime.browserLeases.get(event.sourceId);
      const source = this.source(runtime, event.sourceId);
      const attempt = source?.browser?.attempts.at(-1);
      if (!lease || lease.leaseId !== event.leaseId || lease.attemptId !== event.attemptId ||
        (attempt?.attemptId ?? null) !== event.attemptId || !source || runtime.revoked ||
        !['running', 'paused'].includes(runtime.task.status) ||
        !['browser_reading', 'waiting_user'].includes(source.status)) return;
      source.status = 'waiting_user'; source.reason = event.reason;
      if (attempt) { attempt.phase = 'waiting_user'; attempt.reason = event.reason; attempt.finishedAt = new Date().toISOString(); }
      try { await this.saveSource(runtime, source); }
      catch (error) { await this.storageInterrupted(runtime, source, error); }
    });
  }
  private key(threadId: string, researchRunId: string): string { return `${threadId}/${researchRunId}`; }
  private async runtime(threadId: string, researchRunId: string): Promise<Runtime> {
    this.assertAvailable(threadId);
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
    this.assertAvailable(threadId);
    const closed = task.status === 'completed' || task.status === 'cancelled';
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
    if (!closed && Object.entries(repairedUsage).some(([name, value]) =>
      value !== task.usage[name as keyof typeof repairedUsage])) {
      task.usage = repairedUsage;
      task.revision++;
      task.updatedAt = new Date().toISOString();
      await this.deps.store.saveTask(task);
    }
    const sourceDom = new Map(all.map((source) => [source.sourceId, source.browserDomBytes ?? 0]));
    const domBudget = new BrowserDomBudget(task.budget, task.browserDomBytes ?? 0, sourceDom);
    const recoveredDom = Math.max(task.browserDomBytes ?? 0, [...sourceDom.values()].reduce((sum, bytes) => sum + bytes, 0));
    if (!closed && recoveredDom !== (task.browserDomBytes ?? 0)) {
      task.browserDomBytes = recoveredDom; await this.deps.store.saveTask(task);
    }
    const runtime: Runtime = { task, sources: new Map(all.map((source) => [candidateKey(source.requestedUrl), source])),
      meter, permits: new ModelPermitPool(task.budget.modelConcurrency), controller: new AbortController(),
      pending: false, persistenceFailures: new Set(), domBudget, budgetTail: Promise.resolve(), sourceTails: new Map(),
      browserWork: new Map(), browserControllers: new Map(), browserLeases: new Map(), openWork: new Set(), openIntents: new Map() };
    this.assertAvailable(threadId);
    this.active.set(key, runtime);
    if (task.status === 'running' || task.status === 'paused') {
      for (const source of all) {
        if (source.status === 'browser_reading' || source.status === 'browser_queued' &&
          source.browser?.attempts.at(-1)?.phase !== 'budget_blocked') {
          source.status = 'waiting_user'; source.reason = 'interrupted';
          const attempt = source.browser?.attempts.at(-1);
          if (attempt) { attempt.phase = 'interrupted'; attempt.reason = 'interrupted'; attempt.finishedAt = new Date().toISOString(); }
          await this.deps.store.saveSource(task, source);
        } else if (source.status === 'fetching' || source.status === 'extracting') {
          source.status = 'queued'; source.reason = 'interrupted';
          await this.deps.store.saveSource(task, source);
        }
      }
      this.kick(runtime);
    }
    return runtime;
  }
  private changed(runtime: Runtime): Promise<WebResearchTaskSnapshot> {
    return this.taskSerial(runtime, () => this.persistTask(runtime));
  }
  private async persistTask(runtime: Runtime): Promise<WebResearchTaskSnapshot> {
    const { task, meter } = runtime;
    task.revision++;
    task.updatedAt = new Date().toISOString();
    task.usage = { ...meter.usage };
    try { await this.deps.store.saveTask(task); }
    catch (error) { runtime.persistenceFailures.add(error); throw error; }
    const value = snapshot(task, runtime.sources.values());
    try { this.deps.onUpdate(value); } catch { /* UI observers cannot alter persisted state */ }
    return value;
  }
  private async persistSource(runtime: Runtime, source: WebResearchTaskSource): Promise<void> {
    try { await this.deps.store.saveSource(runtime.task, source); }
    catch (error) { runtime.persistenceFailures.add(error); throw error; }
  }
  private async storageInterrupted(runtime: Runtime, source: WebResearchTaskSource, error: unknown): Promise<void> {
    runtime.task.status = 'paused'; runtime.task.statusReason = 'storage_error';
    source.status = source.browser ? 'waiting_user' : 'queued';
    source.reason = 'interrupted';
    const attempt = source.browser?.attempts.at(-1);
    if (attempt) {
      attempt.phase = 'interrupted'; attempt.finishedAt = new Date().toISOString();
      attempt.reason = error instanceof Error ? error.message : String(error);
    }
    try { await this.saveSource(runtime, source); }
    catch { throw error; } // Never replace the original IO cause with a recovery-write failure.
  }
  private async saveSource(runtime: Runtime, source: WebResearchTaskSource): Promise<void> {
    source.updatedAt = new Date().toISOString();
    await this.persistSource(runtime, source);
    await this.changed(runtime);
  }

  submit(input: TaskSubmitInput, owner: TaskOwner): Promise<TaskSubmitResult> {
    const work = this.submitInternal(input, owner);
    const pending = this.submitting.get(owner.threadId) ?? new Set<Promise<TaskSubmitResult>>();
    pending.add(work); this.submitting.set(owner.threadId, pending);
    return work.finally(() => {
      pending.delete(work); if (!pending.size) this.submitting.delete(owner.threadId);
    });
  }

  private async submitInternal(input: TaskSubmitInput, owner: TaskOwner): Promise<TaskSubmitResult> {
    this.assertAvailable(owner.threadId);
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
      this.assertAvailable(owner.threadId);
      runtime = { task, sources: new Map(), meter: new ResearchBudgetMeter(budget),
        permits: new ModelPermitPool(budget.modelConcurrency), controller: new AbortController(),
        pending: false, persistenceFailures: new Set(), domBudget: new BrowserDomBudget(budget, 0, new Map()), budgetTail: Promise.resolve(),
        sourceTails: new Map(), browserWork: new Map(), browserControllers: new Map(), browserLeases: new Map(), openWork: new Set(), openIntents: new Map() };
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
    this.assertAvailable(owner.threadId);
    await Promise.all([...touched].map((source) => this.deps.store.saveSource(task, source)));
    this.assertAvailable(owner.threadId);
    const current = await this.changed(runtime);
    this.kick(runtime);
    return { researchRunId: task.researchRunId, created, accepted, duplicates, unresolved, rejected,
      observationResults, snapshot: current };
  }

  private kick(runtime: Runtime): void {
    if (runtime.revoked || runtime.finalizing || runtime.task.status !== 'running') return;
    this.kickBrowser(runtime);
    if (runtime.work) { runtime.pending = true; return; }
    const tasks = sorted(runtime.sources.values()).filter((source) => source.status === 'queued' ||
      source.pendingReanalysis && (source.status === 'completed' || source.status === 'failed'));
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
        if (runtime.revoked || runtime.controller.signal.aborted) return;
        if (runtime.persistenceFailures.has(error)) { runtime.idleError = error; return; }
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

  private async queueBrowser(runtime: Runtime, source: WebResearchTaskSource, trigger: BrowserTrigger): Promise<void> {
    await this.sourceSerial(runtime, source.sourceId, async () => {
      if (!['running', 'paused'].includes(runtime.task.status) || runtime.controller.signal.aborted) return;
      source.pendingReanalysis = false;
      if (source.browser?.automaticAttemptUsed || source.retrieval?.method === 'browser') {
        source.status = 'waiting_user'; source.reason = 'needs_browser';
      } else {
        const browser = source.browser ??= { trigger, automaticAttemptUsed: false, attempts: [] };
        browser.automaticAttemptUsed = true;
        browser.attempts.push({ attemptId: randomUUID(), sequence: browser.attempts.length + 1,
          initiatedBy: 'automatic', phase: 'queued', startedAt: new Date().toISOString(),
          requestedUrl: source.finalUrl ?? source.requestedUrl, navigationMode: 'navigate',
          navigationReserved: false, domBytes: 0 });
        source.status = 'browser_queued'; source.reason = undefined;
      }
      await this.saveSource(runtime, source);
    });
    this.kickBrowser(runtime);
  }

  private kickBrowser(runtime: Runtime): void {
    if (runtime.revoked || runtime.finalizing || runtime.task.status !== 'running' || runtime.controller.signal.aborted) return;
    for (const source of sorted(runtime.sources.values())) {
      if (source.status !== 'browser_queued' || runtime.browserWork.has(source.sourceId)) continue;
      const attempt = source.browser?.attempts.at(-1);
      if (!attempt || attempt.phase !== 'queued') continue;
      const work = this.processBrowser(runtime, source, attempt.attemptId).catch(async (error: unknown) => {
        if (runtime.revoked || runtime.controller.signal.aborted) return;
        if (runtime.persistenceFailures.has(error)) { runtime.idleError = error; return; }
        runtime.task.status = 'failed'; runtime.task.statusReason = error instanceof Error ? error.message : String(error);
        await this.changed(runtime);
      }).finally(() => { runtime.browserWork.delete(source.sourceId); this.kickBrowser(runtime); });
      runtime.browserWork.set(source.sourceId, work);
    }
  }

  private domLimitReason(runtime: Runtime, source: WebResearchTaskSource): string {
    return runtime.task.budget.maxBytesPerSource - (source.browserDomBytes ?? 0) <=
      runtime.task.budget.maxTotalBytes - (runtime.task.browserDomBytes ?? 0)
      ? 'browser_source_dom_limit' : 'browser_total_dom_limit';
  }

  private async commitBrowserBody(runtime: Runtime, sourceId: string, attemptId: string,
    body: BodyResult, facts: ResearchDocumentFacts): Promise<boolean> {
    return this.sourceSerial(runtime, sourceId, async () => {
      const attempt = this.currentAttempt(runtime, sourceId, attemptId);
      const source = this.source(runtime, sourceId);
      if (!attempt || !source || body.status !== 'readable' || !body.contentHash || !body.passages.length) return false;
      const replacement: WebResearchTaskSource = { ...source, passages: body.passages, contentHash: body.contentHash,
        completeness: body.completeness === 'truncated' ? 'truncated' : 'unknown', siteIconUrl: body.siteIconUrl,
        finalUrl: facts.url, retrieval: { method: 'browser', attemptId }, extraction: undefined,
        pendingReanalysis: false, status: 'extracting', reason: undefined,
        updatedAt: new Date().toISOString(), browser: { ...source.browser!, attempts: source.browser!.attempts.map((saved) =>
          saved.attemptId !== attemptId ? saved : { ...saved, phase: 'readable', finishedAt: new Date().toISOString(),
            finalUrl: facts.url, mainStatusCode: facts.mainStatusCode, documentContentType: facts.documentContentType, document: facts }) } };
      // Publish the detached replacement only once the atomic source write succeeded.
      await this.persistSource(runtime, replacement);
      if (!this.currentAttempt(runtime, sourceId, attemptId)) return false;
      Object.assign(source, replacement);
      await this.changed(runtime);
      return true;
    });
  }

  private async processBrowser(runtime: Runtime, source: WebResearchTaskSource, attemptId: string): Promise<void> {
    const operation = new AbortController();
    runtime.browserControllers.set(source.sourceId, operation);
    const signal = AbortSignal.any([runtime.controller.signal, operation.signal]);
    let candidate: { body: BodyResult; facts: ResearchDocumentFacts } | undefined;
    try {
      const attempt = source.browser!.attempts.at(-1)!;
      const result = this.deps.browserReader ? await this.deps.browserReader.read({
        threadId: runtime.task.threadId, researchRunId: runtime.task.researchRunId, sourceId: source.sourceId,
        attemptId, requestedUrl: attempt.requestedUrl, mode: attempt.navigationMode, signal,
        onStarted: () => this.sourceSerial(runtime, source.sourceId, async () => {
          const current = this.currentAttempt(runtime, source.sourceId, attemptId);
          if (signal.aborted) throw signal.reason;
          if (!current) throw new Error('attempt_superseded');
          current.phase = 'reading'; source.status = 'browser_reading'; await this.saveSource(runtime, source);
        }),
        beforeNavigate: () => this.sourceSerial(runtime, source.sourceId, () => this.taskSerial(runtime, async () => {
          const current = this.currentAttempt(runtime, source.sourceId, attemptId);
          if (signal.aborted) throw signal.reason;
          if (!current) throw new Error('attempt_superseded');
          const reservation = runtime.meter.reserveFetch();
          if (!reservation.ok) throw new Error(reservation.reason);
          // Task first: a missing source write must never refund the dispatch.
          await this.persistTask(runtime);
          current.navigationReserved = true; current.navigationMode = 'navigate';
          await this.persistSource(runtime, source);
        })),
        remainingDomBytes: () => this.sourceSerial(runtime, source.sourceId, async () => {
          if (signal.aborted) throw signal.reason;
          if (!this.currentAttempt(runtime, source.sourceId, attemptId)) throw new Error('attempt_superseded');
          return runtime.domBudget.remaining(source.sourceId);
        }),
        onDocument: async (document) => {
          const admitted = await this.sourceSerial(runtime, source.sourceId, () => this.taskSerial(runtime, async () => {
            const current = this.currentAttempt(runtime, source.sourceId, attemptId);
            if (signal.aborted || !current) return false;
            runtime.domBudget.record(source.sourceId, document.utf8Bytes);
            source.browserDomBytes = (source.browserDomBytes ?? 0) + document.utf8Bytes;
            current.domBytes += document.utf8Bytes;
            // Source first: aggregate recovery takes max(task, sum(sources)).
            await this.persistSource(runtime, source);
            runtime.task.browserDomBytes = (runtime.task.browserDomBytes ?? 0) + document.utf8Bytes;
            await this.persistTask(runtime);
            return true;
          }));
          if (!admitted) return 'continue';
          const body = await this.deps.parse({ bytes: Buffer.from(document.html, 'utf8'),
            contentType: 'text/html', finalUrl: document.url, sourceId: source.sourceId });
          return this.sourceSerial(runtime, source.sourceId, async () => {
            if (signal.aborted || !this.currentAttempt(runtime, source.sourceId, attemptId) || body.status !== 'readable' ||
              !body.contentHash || !body.passages.length) return 'continue';
            const { html: _html, ...facts } = document;
            candidate = { body, facts }; return 'accepted';
          });
        },
      }) : { status: 'waiting_user' as const, reason: 'browser_unavailable' };
      if (signal.aborted) throw signal.reason;
      if (runtime.task.status !== 'running') throw new Error('task_not_running');
      await this.sourceSerial(runtime, source.sourceId, async () => {
        if (result.leaseId && this.currentAttempt(runtime, source.sourceId, attemptId)) {
          runtime.browserLeases.set(source.sourceId, { attemptId, leaseId: result.leaseId });
        }
      });
      if (result.status === 'readable' && candidate &&
        sameDocumentFacts(candidate.facts, result.document)) {
        if (await this.commitBrowserBody(runtime, source.sourceId, attemptId, candidate.body, result.document)) {
          runtime.browserLeases.delete(source.sourceId);
          await this.deps.browserReader?.release({ threadId: runtime.task.threadId,
            researchRunId: runtime.task.researchRunId, sourceId: source.sourceId }, { closeOwned: true });
          await this.extractAcceptedBody(runtime, source, signal);
        }
        return;
      }
      await this.sourceSerial(runtime, source.sourceId, async () => {
        const current = this.currentAttempt(runtime, source.sourceId, attemptId);
        if (!current) return;
        const reason = result.status === 'budget_blocked' ? this.domLimitReason(runtime, source)
          : result.status === 'readable' ? 'document_changed' : result.reason;
        const status = reason === 'browser_source_dom_limit' || reason === 'navigation_download' ||
          result.status === 'failed' ? 'failed' : result.status === 'budget_blocked' ? 'browser_queued' : 'waiting_user';
        source.status = status; source.reason = reason;
        current.phase = status === 'browser_queued' ? 'budget_blocked' : status;
        current.reason = reason; current.finishedAt = new Date().toISOString();
        if (result.status !== 'readable') { current.finalUrl = result.finalUrl; current.mainStatusCode = result.mainStatusCode; current.documentContentType = result.documentContentType; }
        if (status === 'browser_queued') { runtime.task.status = 'paused'; runtime.task.statusReason = reason; }
        await this.saveSource(runtime, source);
      });
    } catch (error) {
      await this.sourceSerial(runtime, source.sourceId, async () => {
        if (signal.aborted || runtime.revoked) return;
        const current = source.browser?.attempts.at(-1);
        if (runtime.persistenceFailures.has(error)) { await this.storageInterrupted(runtime, source, error); return; }
        if (current?.attemptId !== attemptId) return;
        if (source.status === 'extracting' && source.retrieval?.attemptId === attemptId) {
          source.status = signal.aborted ? 'queued' : 'failed'; source.pendingReanalysis = signal.aborted;
          source.reason = signal.aborted ? 'interrupted' : error instanceof Error ? error.message : 'source_error';
          await this.saveSource(runtime, source); return;
        }
        if (!['browser_queued', 'browser_reading'].includes(source.status)) return;
        const taskBlocked = runtime.task.status === 'paused' && !signal.aborted;
        const reason = taskBlocked ? runtime.task.statusReason ?? 'task_paused'
          : error instanceof Error ? error.message : 'browser_error';
        const budget = reason === 'fetch_limit' || reason === 'browser_total_dom_limit';
        source.status = budget ? 'browser_queued' : signal.aborted || taskBlocked ? 'waiting_user' : 'failed';
        source.reason = signal.aborted ? 'interrupted' : reason;
        current.phase = budget ? 'budget_blocked' : signal.aborted || taskBlocked ? 'interrupted' : 'failed';
        current.reason = source.reason; current.finishedAt = new Date().toISOString();
        if (budget) { runtime.task.status = 'paused'; runtime.task.statusReason = reason; }
        await this.saveSource(runtime, source);
      });
    } finally {
      if (runtime.browserControllers.get(source.sourceId) === operation) runtime.browserControllers.delete(source.sourceId);
    }
  }

  private async processSource(runtime: Runtime, source: WebResearchTaskSource): Promise<void> {
    const { task, meter } = runtime;
    const signal = runtime.controller.signal;
    try {
      if (new URL(source.requestedUrl).pathname.toLowerCase().endsWith('.pdf')) {
        source.status = 'failed'; source.reason = 'pdf_url_excluded';
        await this.saveSource(runtime, source); return;
      }
      if (!source.contentHash || !source.passages.length ||
        (!source.pendingReanalysis && source.reason !== 'interrupted')) {
        const reserved = await this.taskSerial(runtime, async () => {
          if (signal.aborted || runtime.revoked) throw new Error('research_interrupted');
          const reservation = meter.reserveFetch(source.sourceId);
          if (!reservation.ok) { task.status = 'paused'; task.statusReason = reservation.reason; }
          await this.persistTask(runtime); return reservation;
        });
        if (!reserved.ok) return;
        await this.sourceSerial(runtime, source.sourceId, async () => {
          if (signal.aborted || runtime.revoked) return;
          source.status = 'fetching'; source.reason = undefined; await this.saveSource(runtime, source);
        });
        if (signal.aborted || runtime.revoked) return;
        const resolvedUrls = resolveSourceUrls(source.requestedUrl);
        source.contentUrl = resolvedUrls.contentUrl;
        const fetched = await this.deps.fetch({ url: resolvedUrls.contentUrl, sourceId: source.sourceId,
          budget: meter, signal, preReserved: true });
        const trigger = browserTrigger({ source, fetch: fetched });
        await this.sourceSerial(runtime, source.sourceId, async () => {
          if (signal.aborted || runtime.revoked) return;
          source.contentFinalUrl = fetched.finalUrl;
          source.finalUrl = resolvedUrls.contentUrl === resolvedUrls.reportUrl ? fetched.finalUrl : resolvedUrls.reportUrl;
          source.redirectChain = fetched.redirectChain; source.contentType = fetched.contentType;
          source.statusCode = fetched.statusCode; source.receivedBytes = fetched.receivedBytes;
          if (signal.aborted) { source.status = 'queued'; }
          else if (fetched.reason === 'total_byte_limit') {
            source.status = 'queued'; source.reason = fetched.reason; task.status = 'paused'; task.statusReason = fetched.reason;
          } else if (!trigger && (fetched.status !== 'readable' || !fetched.finalUrl)) {
            source.status = 'failed'; source.reason = fetched.reason ?? fetched.status;
          }
          await this.saveSource(runtime, source);
        });
        if (signal.aborted || fetched.reason === 'total_byte_limit') return;
        if (trigger) { await this.queueBrowser(runtime, source, trigger); return; }
        if (fetched.status !== 'readable' || !fetched.finalUrl) return;
        const body = await this.deps.parse({ bytes: fetched.bytes, contentType: fetched.contentType,
          finalUrl: fetched.finalUrl, sourceId: source.sourceId });
        if (signal.aborted || runtime.revoked) return;
        const bodyTrigger = browserTrigger({ source, body });
        if (bodyTrigger) { await this.queueBrowser(runtime, source, bodyTrigger); return; }
        await this.sourceSerial(runtime, source.sourceId, async () => {
          if (signal.aborted || runtime.revoked) return;
          source.passages = body.passages; source.contentHash = body.contentHash; source.completeness = body.completeness;
          source.siteIconUrl = body.siteIconUrl; source.retrieval = { method: 'http' };
          if (body.status !== 'readable' || !body.passages.length || !body.contentHash) {
            source.status = 'failed'; source.reason = body.reason ?? body.status;
          }
          await this.saveSource(runtime, source);
        });
        if (body.status !== 'readable' || !body.passages.length || !body.contentHash) return;
      }
      await this.extractAcceptedBody(runtime, source, signal);
    } catch (error) {
      await this.sourceSerial(runtime, source.sourceId, async () => {
        if (signal.aborted || runtime.revoked) return;
        if (runtime.persistenceFailures.has(error)) { await this.storageInterrupted(runtime, source, error); return; }
        source.status = signal.aborted ? 'queued' : 'failed';
        source.reason = signal.aborted ? 'interrupted' : error instanceof Error ? error.message : 'source_error';
        await this.saveSource(runtime, source);
      });
    }
  }

  private async extractAcceptedBody(runtime: Runtime, source: WebResearchTaskSource, signal: AbortSignal): Promise<void> {
    const { task, meter } = runtime;
    if (signal.aborted) return;
    const hash = source.contentHash, retrievalAttempt = source.retrieval?.attemptId, status = source.status;
    const model = task.modelSnapshot ?? await this.deps.resolveModel(task.threadId);
    await this.taskSerial(runtime, async () => {
      if (signal.aborted || runtime.revoked) return;
      task.modelSnapshot ??= model; await this.persistTask(runtime);
    });
    const admitted = await this.sourceSerial(runtime, source.sourceId, async () => {
      if (source.contentHash !== hash || source.retrieval?.attemptId !== retrievalAttempt || source.status !== status) return false;
      if (task.status === 'paused' && !signal.aborted) {
        // An independent browser budget can pause the task while this accepted
        // HTTP/browser body awaits model admission. Keep it schedulable on resume.
        source.status = 'queued'; source.pendingReanalysis = true; source.reason = 'interrupted';
        await this.saveSource(runtime, source); return false;
      }
      if (signal.aborted || task.status !== 'running') return false;
      source.status = 'extracting'; source.pendingReanalysis = false; await this.saveSource(runtime, source); return true;
    });
    if (!admitted) return;
    const discoveryCount = source.discoveries.length;
    let persistenceFailure: { error: unknown } | undefined;
    const adapter: ModelAdapter = { currentRevision: () => this.deps.adapter.currentRevision(),
      complete: async (request) => {
        try { await this.changed(runtime); }
        catch (error) { persistenceFailure = { error }; throw error; }
        return this.deps.adapter.complete(request);
      } };
    const extraction = await (this.deps.extract ?? extractSource)({ sourceId: source.sourceId,
      question: task.originalQuestion, angles: task.angles, discoveries: source.discoveries as Discovery[],
      passages: source.passages, completeness: source.completeness ?? 'unknown', modelSnapshot: task.modelSnapshot!,
      budget: meter, signal, permits: runtime.permits, adapter });
    // extractSource normalizes adapter errors; an owner save failure keeps its original cause.
    if (persistenceFailure) throw persistenceFailure.error;
    let trigger: BrowserTrigger | undefined;
    await this.sourceSerial(runtime, source.sourceId, async () => {
      if (signal.aborted || runtime.revoked) return;
      if (source.contentHash !== hash || source.retrieval?.attemptId !== retrievalAttempt || source.status !== 'extracting') return;
      if (signal.aborted) { source.status = 'queued'; source.pendingReanalysis = true; }
      else if (extraction.reason === 'model_call_limit') {
        source.status = 'queued'; source.pendingReanalysis = true; task.status = 'paused'; task.statusReason = extraction.reason;
      } else {
        source.extraction = extraction; trigger = browserTrigger({ source, extraction });
        source.status = extraction.status === 'claims' || extraction.status === 'irrelevant' ? 'completed' : 'failed';
        source.reason = extraction.reason; source.pendingReanalysis ||= source.discoveries.length > discoveryCount;
      }
      await this.saveSource(runtime, source);
    });
    if (trigger) await this.queueBrowser(runtime, source, trigger);
  }

  async whenIdle(threadId: string, researchRunId: string): Promise<void> {
    const runtime = await this.runtime(threadId, researchRunId);
    await this.drain(runtime);
    if (runtime.idleError !== undefined) throw runtime.idleError;
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

  private assertAvailable(threadId: string): void {
    if (this.stopped || this.disposedThreads.has(threadId)) throw new Error('research service disposed');
  }
  private assertMutable(runtime: Runtime): void {
    this.assertAvailable(runtime.task.threadId);
    if (runtime.finalizing) throw new Error('task is completing');
    if (runtime.task.status === 'completed' || runtime.task.status === 'cancelled') throw new Error('task is closed');
  }
  private sourceKey(runtime: Runtime, sourceId: string): BrowserSourceKey {
    return { threadId: runtime.task.threadId, researchRunId: runtime.task.researchRunId, sourceId };
  }
  private async drain(runtime: Runtime): Promise<void> {
    while (runtime.work || runtime.browserWork.size || runtime.sourceTails.size || runtime.openWork.size) {
      await Promise.allSettled([runtime.work, ...runtime.browserWork.values(),
        ...runtime.sourceTails.values(), ...runtime.openWork]);
    }
    await runtime.budgetTail;
  }
  private abort(runtime: Runtime): void {
    runtime.controller.abort(new Error('research_interrupted'));
    for (const controller of runtime.openIntents.values()) controller.abort(new Error('attempt_superseded'));
    runtime.openIntents.clear();
  }
  private async releaseSources(runtime: Runtime): Promise<void> {
    await Promise.all([...runtime.sources.values()].map(source =>
      this.deps.browserReader?.release(this.sourceKey(runtime, source.sourceId), { closeOwned: true })));
    runtime.browserLeases.clear();
  }
  private async settleInterrupted(runtime: Runtime, cancelled: boolean): Promise<void> {
    for (const source of runtime.sources.values()) {
      await this.sourceSerial(runtime, source.sourceId, async () => {
        if (!isOutstandingSource(source.status)) return;
        if (cancelled) { source.status = 'cancelled'; source.reason = 'cancelled_by_user'; }
        else if (source.status === 'browser_reading' || source.status === 'browser_queued') {
          source.status = 'waiting_user'; source.reason = 'interrupted';
        } else if (source.status === 'fetching' || source.status === 'extracting') {
          source.pendingReanalysis = Boolean(source.contentHash && source.passages.length);
          source.status = 'queued'; source.reason = 'interrupted';
        } else return;
        const attempt = source.browser?.attempts.at(-1);
        if (attempt && (cancelled || source.reason === 'interrupted')) {
          attempt.phase = cancelled ? 'cancelled' : 'interrupted';
          attempt.reason = source.reason; attempt.finishedAt = new Date().toISOString();
        }
        await this.persistSource(runtime, source);
      });
    }
  }
  /** Caller owns sourceSerial. A fresh intent never refunds navigation or DOM use. */
  private async explicitAttempt(runtime: Runtime, source: WebResearchTaskSource, initiatedBy: 'user' | 'resume'): Promise<void> {
    const trigger = source.browser?.trigger ?? browserTrigger({ source, legacyResume: true });
    if (!trigger) throw new Error('source does not require browser');
    runtime.openIntents.get(source.sourceId)?.abort(new Error('attempt_superseded'));
    runtime.openIntents.delete(source.sourceId);
    runtime.browserControllers.get(source.sourceId)?.abort(new Error('attempt_superseded'));
    const browser = source.browser ??= { trigger, automaticAttemptUsed: true, attempts: [] };
    const previous = browser.attempts.at(-1);
    if (previous && (previous.phase === 'queued' || previous.phase === 'reading')) {
      previous.phase = 'interrupted'; previous.reason = 'attempt_superseded'; previous.finishedAt = new Date().toISOString();
    }
    browser.attempts.push({ attemptId: randomUUID(), sequence: browser.attempts.length + 1,
      initiatedBy, phase: 'queued', startedAt: new Date().toISOString(),
      requestedUrl: source.finalUrl ?? source.requestedUrl,
      navigationMode: this.deps.browserReader?.currentTab(this.sourceKey(runtime, source.sourceId)) ? 'capture_existing' : 'navigate',
      navigationReserved: false, domBytes: 0 });
    source.status = 'browser_queued'; source.reason = undefined; source.pendingReanalysis = false;
    await this.saveSource(runtime, source);
    runtime.idleError = undefined;
  }

  async retrySource(input: BrowserSourceKey & { expectedAttemptId: string | null }): Promise<WebResearchTaskSnapshot> {
    const runtime = await this.runtime(input.threadId, input.researchRunId);
    await this.sourceSerial(runtime, input.sourceId, async () => {
      this.assertMutable(runtime);
      if (runtime.task.status !== 'running') throw new Error('task is paused');
      const source = this.source(runtime, input.sourceId);
      if (!source) throw new Error('source not found');
      if ((source.browser?.attempts.at(-1)?.attemptId ?? null) !== input.expectedAttemptId) return;
      if (!['waiting_user', 'failed', 'browser_queued', 'browser_reading'].includes(source.status)) throw new Error('source is not retryable');
      await this.explicitAttempt(runtime, source, 'user');
    });
    this.kickBrowser(runtime);
    return snapshot(runtime.task, runtime.sources.values());
  }

  async openSource(key: BrowserSourceKey): Promise<{ tabId: string; expectedAttemptId: string | null; snapshot: WebResearchTaskSnapshot }> {
    const runtime = await this.runtime(key.threadId, key.researchRunId);
    const controller = new AbortController();
    const work = (async () => {
      const intent = await this.sourceSerial(runtime, key.sourceId, async () => {
        this.assertMutable(runtime);
        const source = this.source(runtime, key.sourceId);
        if (!source) throw new Error('source not found');
        if (!source.browser && !browserTrigger({ source, legacyResume: true })) throw new Error('source does not require browser');
        runtime.openIntents.get(key.sourceId)?.abort(new Error('attempt_superseded'));
        runtime.openIntents.set(key.sourceId, controller);
        return { requestedUrl: source.finalUrl ?? source.requestedUrl, expectedAttemptId: source.browser?.attempts.at(-1)?.attemptId ?? null };
      });
      const check = () => {
        this.assertMutable(runtime);
        if (controller.signal.aborted || runtime.openIntents.get(key.sourceId) !== controller ||
          (this.source(runtime, key.sourceId)?.browser?.attempts.at(-1)?.attemptId ?? null) !== intent.expectedAttemptId) throw new Error('attempt_superseded');
      };
      if (!this.deps.browserReader) throw new Error('browser_unavailable');
      const receipt = await this.deps.browserReader.openForUser({ ...key, requestedUrl: intent.requestedUrl,
        attemptId: intent.expectedAttemptId, signal: controller.signal,
        beforeNavigate: () => this.sourceSerial(runtime, key.sourceId, () => this.taskSerial(runtime, async () => {
          check(); const reserved = runtime.meter.reserveFetch();
          if (!reserved.ok) throw new Error(reserved.reason);
          await this.persistTask(runtime); check();
        })) });
      return this.sourceSerial(runtime, key.sourceId, async () => {
        check(); runtime.browserLeases.set(key.sourceId, { attemptId: intent.expectedAttemptId, leaseId: receipt.leaseId });
        return { tabId: receipt.tabId, expectedAttemptId: intent.expectedAttemptId, snapshot: snapshot(runtime.task, runtime.sources.values()) };
      });
    })();
    runtime.openWork.add(work);
    try { return await work; }
    finally { runtime.openWork.delete(work); if (runtime.openIntents.get(key.sourceId) === controller) runtime.openIntents.delete(key.sourceId); }
  }

  async control(threadId: string, researchRunId: string, action: 'pause' | 'resume' | 'cancel'):
    Promise<WebResearchTaskSnapshot> {
    const runtime = await this.runtime(threadId, researchRunId);
    const work = (runtime.controlWork ?? Promise.resolve()).catch(() => {}).then(async () => {
      this.assertMutable(runtime);
      if (action === 'resume') {
        // Each in-flight operation retains its own revoked signal; resume never waits on a page.
        runtime.task.status = 'running'; runtime.task.statusReason = undefined;
        if (runtime.controller.signal.aborted) runtime.controller = new AbortController();
        for (const source of runtime.sources.values()) await this.sourceSerial(runtime, source.sourceId, async () => {
          const interrupted = source.reason === 'interrupted' && source.status === 'waiting_user';
          const legacy = !source.browser && source.status === 'failed' && browserTrigger({ source, legacyResume: true });
          if (source.status === 'browser_queued' || interrupted || legacy) await this.explicitAttempt(runtime, source, 'resume');
        });
        const value = await this.changed(runtime); runtime.idleError = undefined;
        this.kick(runtime); return value;
      }
      runtime.task.status = action === 'pause' ? 'paused' : 'cancelled';
      runtime.task.statusReason = action === 'pause' ? 'paused_by_user' : 'cancelled_by_user';
      this.abort(runtime);
      if (action === 'cancel') { await this.releaseSources(runtime); await this.drain(runtime); }
      await this.settleInterrupted(runtime, action === 'cancel');
      return this.changed(runtime);
    });
    runtime.controlWork = work;
    try { return await work; }
    finally { if (runtime.controlWork === work) runtime.controlWork = undefined; }
  }

  /** Revoke now; only disposal-owned state writes may run after this point. */
  disposeThread(threadId: string): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    const existing = this.disposing.get(threadId);
    if (existing) return existing;
    this.disposedThreads.add(threadId);
    const runtimes = [...this.active.values()].filter(runtime => runtime.task.threadId === threadId);
    for (const runtime of runtimes) { runtime.revoked = true; this.abort(runtime); }
    const work = (async () => {
      await Promise.allSettled(this.submitting.get(threadId) ?? []);
      await Promise.allSettled([...this.loading.entries()].filter(([key]) => key.startsWith(`${threadId}/`)).map(([, work]) => work));
      for (const runtime of runtimes) {
        await this.releaseSources(runtime); await this.drain(runtime); await runtime.controlWork?.catch(() => {}); await runtime.finalizationWork?.catch(() => {});
        if (!['completed', 'cancelled'].includes(runtime.task.status)) {
          runtime.task.status = 'cancelled'; runtime.task.statusReason = 'thread_disposed';
          await this.settleInterrupted(runtime, true); await this.changed(runtime);
        }
        this.active.delete(this.key(threadId, runtime.task.researchRunId));
      }
    })();
    this.disposing.set(threadId, work);
    return work;
  }

  shutdown(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    this.stopped = true; this.offLease?.();
    const runtimes = [...this.active.values()].filter(runtime => !this.disposedThreads.has(runtime.task.threadId));
    for (const runtime of runtimes) { runtime.revoked = true; this.abort(runtime); }
    const reader = this.deps.browserReader?.dispose();
    this.shutdownWork = (async () => {
      await reader;
      await Promise.allSettled([...this.submitting.values()].flatMap(pending => [...pending]));
      await Promise.all(this.disposing.values());
      await Promise.allSettled(this.loading.values());
      for (const runtime of runtimes) {
        await this.drain(runtime); await runtime.controlWork?.catch(() => {}); await runtime.finalizationWork?.catch(() => {});
        if (['completed', 'cancelled'].includes(runtime.task.status)) continue;
        runtime.task.status = 'paused'; runtime.task.statusReason = 'interrupted';
        await this.settleInterrupted(runtime, false); await this.changed(runtime);
      }
    })();
    return this.shutdownWork;
  }

  async complete(threadId: string, researchRunId: string, reportMarkdown: string,
    fileName?: string, unprocessedReason?: string): Promise<TaskCompleteResult> {
    const runtime = await this.runtime(threadId, researchRunId);
    this.assertMutable(runtime);
    const work = this.completeRuntime(runtime, reportMarkdown, fileName, unprocessedReason);
    runtime.finalizationWork = work;
    try { return await work; }
    finally { if (runtime.finalizationWork === work) runtime.finalizationWork = undefined; }
  }

  private async completeRuntime(runtime: Runtime, reportMarkdown: string,
    fileName?: string, unprocessedReason?: string): Promise<TaskCompleteResult> {
    if (runtime.finalizing) throw new Error('task is completing');
    if (runtime.task.status === 'completed' || runtime.task.status === 'cancelled') throw new Error('task is closed');
    const hasOutstanding = sorted(runtime.sources.values()).some((source) =>
      isOutstandingSource(source.status));
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
      this.abort(runtime);
      await this.changed(runtime);
      await this.releaseSources(runtime);
      await this.drain(runtime);
      const sources = sorted(runtime.sources.values());
      const queued = sources.filter((source) => isOutstandingSource(source.status));
      this.assertAvailable(runtime.task.threadId);
      const report = await completeReport(runtime.task, sources, reportMarkdown, fileName,
        unprocessedReason, () => this.assertAvailable(runtime.task.threadId));
      if (!report.completed) {
        runtime.task.status = previousStatus;
        runtime.task.statusReason = previousStatusReason;
        if (previousStatus === 'running') runtime.controller = new AbortController();
        const current = await this.changed(runtime);
        runtime.finalizing = false;
        if (previousStatus === 'running') this.kick(runtime);
        return { completed: false, validationErrors: report.validationErrors, snapshot: current };
      }
      for (const source of queued) { source.status = 'unprocessed'; source.reason = unprocessedReason;
        await this.persistSource(runtime, source); }
      runtime.task.reportPath = report.reportPath;
      runtime.task.unprocessedReason = unprocessedReason;
      runtime.task.status = 'completed';
      runtime.task.statusReason = undefined;
      const current = await this.changed(runtime);
      return { completed: true, reportPath: report.reportPath, snapshot: current };
    } catch (error) {
      if (runtime.revoked) throw error;
      runtime.task.status = 'paused';
      runtime.task.statusReason = error instanceof Error ? error.message : String(error);
      await this.changed(runtime);
      throw error;
    } finally {
      runtime.finalizing = false;
    }
  }
}
