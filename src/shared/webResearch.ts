/** Web research records passed from the IAB search phase to the main-process collector. */
export const SEARCH_ENGINE_IDS = ['google', 'bing', 'duckduckgo', 'baidu'] as const;
export type SearchEngineId = (typeof SEARCH_ENGINE_IDS)[number];

export type ResearchAngle = { id: string; label: string; query: string; rationale?: string };
export type SearchAttempt = {
  attemptId: string;
  angleIds: string[];
  engineId: SearchEngineId;
  query: string;
  searchPageUrl?: string;
  status: 'results' | 'explicit_empty' | 'blocked' | 'navigation_error' | 'extraction_error';
  reason?: string;
};
export type Discovery = {
  attemptId: string;
  angleId: string;
  engineId: SearchEngineId;
  query: string;
  resultUrl: string;
  title?: string;
  snippet?: string;
  searchPageUrl: string;
};
/** Stable location within one saved source; source bytes stay outside the agent context. */
export type Passage = {
  passageId: string;
  sourceId: string;
  ordinal: number;
  text: string;
  heading?: string;
  pageNumber?: number;
};
export type Evidence = {
  evidenceId: string;
  claimId: string;
  sourceId: string;
  passageId: string;
  quote: string;
  relation: 'supports' | 'contradicts' | 'context';
  verification: 'grounded' | 'unverified';
};
export type ExtractedClaim = {
  claimId: string;
  sourceId: string;
  statement: string;
  relevantAngleIds: string[];
  evidenceIds: string[];
  verification: 'grounded' | 'unverified';
};
export type SourceExtraction = {
  sourceId: string;
  status: 'claims' | 'irrelevant' | 'incomplete' | 'failed';
  claims: ExtractedClaim[];
  evidence: Evidence[];
  examinedPassageIds: string[];
  gaps: string[];
  reason?: string;
};
export type ResearchTaskStatus = 'queued' | 'fetching' | 'extracting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ResearchSourceIndex = {
  sourceId: string;
  requestedUrl: string;
  finalUrl?: string;
  redirectChain?: RedirectHop[];
  statusCode?: number;
  contentType?: string;
  canonicalUrl?: string;
  assurance?: 'dns_pinned' | 'proxy_dns_unverified';
  publishedAt?: string;
  contentHash?: string;
  completeness?: 'complete' | 'truncated' | 'unknown';
  status: ResearchTaskStatus;
  reason?: string;
  discoveries: Discovery[];
  receivedBytes?: number;
  evidenceIds?: string[];
  aliasOf?: string;
  /** Last grounded extraction predates one or more saved discoveries. */
  pendingReanalysis?: boolean;
};
/** Safe for renderer and model-visible lists: passage text lives only in source files. */
export type ResearchRunIndex = {
  researchRunId: string;
  threadId: string;
  createdByRunId: string;
  continuationRunIds: string[];
  modelSnapshot?: { providerId: string; modelId: string; runtimeRevision: number };
  originalQuestion: string;
  createdAt: string;
  updatedAt: string;
  angles: ResearchAngle[];
  enabledEngines: SearchEngineId[];
  attempts: SearchAttempt[];
  candidates: Array<{ requestedUrl: string; discoveries: Discovery[] }>;
  budget: ResearchBudget;
  usage: ResearchUsage;
  sources: ResearchSourceIndex[];
};
/** A single bounded passage opened explicitly by evidence ID. */
export type ResearchEvidenceExcerpt = {
  evidenceId: string;
  sourceId: string;
  finalUrl: string;
  passageId: string;
  heading?: string;
  pageNumber?: number;
  quote: string;
  relation: Evidence['relation'];
  verification: Evidence['verification'];
  excerpt: string;
  excerptTruncated: boolean;
};
export type Candidate = {
  requestedUrl: string;
  discoveries: Discovery[];
  selected: boolean;
  selectionReason: string;
};
export type RedirectHop = {
  fromUrl: string;
  toUrl: string;
  kind: 'http' | 'meta_refresh';
  statusCode?: number;
};
export type ResearchBudget = {
  maxCandidates: number;
  maxFetches: number;
  maxTotalBytes: number;
  maxBytesPerSource: number;
  maxModelCalls: number;
  maxOutputTokensPerCall: number;
  maxRedirectsPerSource: number;
  fetchConcurrency: number;
  modelConcurrency: number;
};
export type ResearchUsage = {
  candidates: number;
  fetchesDispatched: number;
  receivedBytes: number;
  modelCalls: number;
};
export type CollectInput = {
  researchRunId?: string;
  originalQuestion: string;
  angles: ResearchAngle[];
  enabledEngines: SearchEngineId[];
  attempts: SearchAttempt[];
  discoveries: Discovery[];
  budget: ResearchBudget;
  /** Keys explicitly supplied by the caller, so continuation does not reset prior limits to defaults. */
  budgetOverrides?: Partial<ResearchBudget>;
  refresh: boolean;
};

export const DEFAULT_RESEARCH_BUDGET: Readonly<ResearchBudget> = Object.freeze({
  maxCandidates: 100,
  maxFetches: 24,
  maxTotalBytes: 96 * 1024 * 1024,
  maxBytesPerSource: 12 * 1024 * 1024,
  maxModelCalls: 96,
  maxOutputTokensPerCall: 1536,
  maxRedirectsPerSource: 8,
  fetchConcurrency: 4,
  modelConcurrency: 3,
});

function fail(path: string): never { throw new Error(`Invalid web research input: ${path}`); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path);
  return value as Record<string, unknown>;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path);
  return value;
}
function nonempty(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(path);
  return value;
}
function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : nonempty(value, path);
}
function httpUrl(value: unknown, path: string): string {
  const raw = nonempty(value, path);
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) fail(path);
  } catch { fail(path); }
  return raw;
}
function engine(value: unknown, path: string): SearchEngineId {
  if (typeof value !== 'string' || !(SEARCH_ENGINE_IDS as readonly string[]).includes(value)) fail(path);
  return value as SearchEngineId;
}
function budgetValue(value: unknown, path: string, allowZero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail(path);
  return value;
}

export function validateResearchBudget(raw: unknown): ResearchBudget {
  const input = raw === undefined ? {} : object(raw, 'budget');
  const budget = { ...DEFAULT_RESEARCH_BUDGET };
  for (const key of Object.keys(budget) as Array<keyof ResearchBudget>) {
    if (input[key] !== undefined) budget[key] = budgetValue(input[key], `budget.${key}`, key === 'maxRedirectsPerSource');
  }
  if (budget.maxFetches > DEFAULT_RESEARCH_BUDGET.maxFetches &&
      (input.maxTotalBytes === undefined || budget.maxTotalBytes <= DEFAULT_RESEARCH_BUDGET.maxTotalBytes ||
       input.maxModelCalls === undefined || budget.maxModelCalls <= DEFAULT_RESEARCH_BUDGET.maxModelCalls)) {
    fail('budget: raising maxFetches also requires explicit higher maxTotalBytes and maxModelCalls');
  }
  return budget;
}

export function validateCollectInput(raw: unknown): CollectInput {
  const input = object(raw, 'root');
  const originalQuestion = nonempty(input.originalQuestion, 'originalQuestion');
  const researchRunId = optionalString(input.researchRunId, 'researchRunId');
  if (researchRunId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(researchRunId)) fail('researchRunId');
  const angles = array(input.angles, 'angles').map((value, index): ResearchAngle => {
    const a = object(value, `angles[${index}]`);
    return { id: nonempty(a.id, 'angle.id'), label: nonempty(a.label, 'angle.label'),
      query: nonempty(a.query, 'angle.query'), rationale: optionalString(a.rationale, 'angle.rationale') };
  });
  if (!angles.length || new Set(angles.map((a) => a.id)).size !== angles.length) fail('angles: empty or duplicate id');
  const angleIds = new Set(angles.map((a) => a.id));
  const enabledEngines = array(input.enabledEngines, 'enabledEngines').map((v) => engine(v, 'enabledEngines[]'));
  if (!enabledEngines.length || new Set(enabledEngines).size !== enabledEngines.length) fail('enabledEngines: empty or duplicate');
  const enabled = new Set(enabledEngines);
  const attempts = array(input.attempts, 'attempts').map((value, index): SearchAttempt => {
    const a = object(value, `attempts[${index}]`);
    const engineId = engine(a.engineId, 'attempt.engineId');
    if (!enabled.has(engineId)) fail('attempt.engineId not enabled');
    const attemptAngleIds = array(a.angleIds, 'attempt.angleIds').map((v) => nonempty(v, 'attempt.angleId'));
    if (!attemptAngleIds.length || new Set(attemptAngleIds).size !== attemptAngleIds.length ||
        attemptAngleIds.some((id) => !angleIds.has(id))) fail('attempt.angleIds');
    const status = a.status;
    if (!['results', 'explicit_empty', 'blocked', 'navigation_error', 'extraction_error'].includes(String(status))) fail('attempt.status');
    return { attemptId: nonempty(a.attemptId, 'attempt.attemptId'), angleIds: attemptAngleIds,
      engineId, query: nonempty(a.query, 'attempt.query'),
      searchPageUrl: a.searchPageUrl === undefined ? undefined : httpUrl(a.searchPageUrl, 'attempt.searchPageUrl'),
      status: status as SearchAttempt['status'], reason: optionalString(a.reason, 'attempt.reason') };
  });
  if (new Set(attempts.map((a) => a.attemptId)).size !== attempts.length) fail('attempts: duplicate id');
  const byAttempt = new Map(attempts.map((a) => [a.attemptId, a]));
  const discoveries = array(input.discoveries, 'discoveries').map((value, index): Discovery => {
    const d = object(value, `discoveries[${index}]`);
    const attemptId = nonempty(d.attemptId, 'discovery.attemptId');
    const attempt = byAttempt.get(attemptId);
    if (!attempt || attempt.status !== 'results') fail('discovery.attemptId');
    const angleId = nonempty(d.angleId, 'discovery.angleId');
    const engineId = engine(d.engineId, 'discovery.engineId');
    const query = nonempty(d.query, 'discovery.query');
    const searchPageUrl = httpUrl(d.searchPageUrl, 'discovery.searchPageUrl');
    if (!attempt.angleIds.includes(angleId) || engineId !== attempt.engineId || query !== attempt.query ||
        searchPageUrl !== attempt.searchPageUrl) fail('discovery provenance');
    return { attemptId, angleId, engineId, query,
      resultUrl: httpUrl(d.resultUrl, 'discovery.resultUrl'), searchPageUrl,
      title: optionalString(d.title, 'discovery.title'), snippet: optionalString(d.snippet, 'discovery.snippet') };
  });
  if (input.refresh !== undefined && typeof input.refresh !== 'boolean') fail('refresh');
  const rawBudget = input.budget === undefined ? {} : object(input.budget, 'budget');
  const budget = validateResearchBudget(input.budget);
  const budgetOverrides = Object.fromEntries((Object.keys(budget) as Array<keyof ResearchBudget>)
    .filter((key) => rawBudget[key] !== undefined).map((key) => [key, budget[key]])) as Partial<ResearchBudget>;
  return { researchRunId, originalQuestion, angles, enabledEngines, attempts, discoveries,
    budget, budgetOverrides, refresh: input.refresh === true };
}
