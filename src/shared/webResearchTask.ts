import type { Discovery, Passage, ResearchAngle, ResearchBudget, ResearchUsage,
  SearchAttempt, SearchEngineId, SourceExtraction } from './webResearch';

export type SearchObservationRow = {
  rawHref: string;
  targetUrl?: string;
  title?: string;
  snippet?: string;
};

export type SearchExecutionPath = 'homepage_form' | 'search_url' | 'result_page_form' | 'status_only';

export type SearchSemanticLocator = {
  role: string;
  name: string | string[];
  visible: true;
};

export type SearchExecutionFacts = {
  startUrl: string;
  endUrl: string;
  completedSubmitAction?: {
    kind: 'click' | 'key';
    selector?: string;
    locator?: SearchSemanticLocator;
    key?: string;
  };
  successfulWaits: Array<
    { urlMatches: string } |
    { selector: string; state: 'present' | 'absent' }
  >;
};

export type SearchExecutionFailure = {
  stage: 'submission' | 'navigation' | 'extraction';
  actionIndex: number;
  actionKind: string;
  message: string;
  selector?: string;
  locator?: SearchSemanticLocator;
  key?: string;
};

/** A search result exists only after an IAB extraction captured it. */
export type SearchObservation = {
  observationId: string;
  threadId: string;
  tabId: string;
  engineId: SearchEngineId;
  attemptId: string;
  query: string;
  searchPageUrl: string;
  angleIds: string[];
  status: import('./webResearch').SearchAttempt['status'];
  executionPath: SearchExecutionPath;
  inputSubmitted: boolean;
  navigationConfirmed: boolean;
  resultsExtracted: boolean;
  executionFacts: SearchExecutionFacts;
  failure?: SearchExecutionFailure;
  createdAt: string;
  rowTruncation: { truncated: boolean; returned: number; totalKnown: number };
  rows: SearchObservationRow[];
  submittedToResearch?: { researchRunId: string; submittedAt: string };
};

export type ObservationSelection = { observationId: string; resultIndexes: number[] };

export type ObservationSubmitDetail = ObservationSelection & {
  acceptedIndexes: number[];
  duplicateIndexes: number[];
  unresolvedIndexes: number[];
  rejectedIndexes: number[];
};

export type SearchObservationSummary = Pick<SearchObservation,
  'observationId' | 'engineId' | 'query' | 'executionPath' | 'status' |
  'inputSubmitted' | 'navigationConfirmed' | 'resultsExtracted' | 'executionFacts' | 'failure'> & {
  candidateCount: number;
  confirmedCount: number;
  unresolvedCount: number;
};

export type WebResearchTaskState = 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
export type WebResearchSourceState = 'queued' | 'fetching' | 'extracting' | 'completed' |
  'failed' | 'cancelled' | 'unprocessed';

export type WebResearchTaskRecord = {
  researchRunId: string;
  threadId: string;
  createdByRunId: string;
  projectRoot: string;
  originalQuestion: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  status: WebResearchTaskState;
  statusReason?: string;
  reportPath?: string;
  unprocessedReason?: string;
  angles: ResearchAngle[];
  attempts: SearchAttempt[];
  observationIds: string[];
  observationSelections?: ObservationSelection[];
  /** Observations with candidates deferred by maxCandidates; replay after a budget raise. */
  deferredObservationIds?: string[];
  discoveryCount: number;
  budget: ResearchBudget;
  usage: ResearchUsage;
  modelSnapshot?: { providerId: string; modelId: string; runtimeRevision: number };
};

export type WebResearchTaskSource = {
  sourceId: string;
  requestedUrl: string;
  contentUrl?: string;
  contentFinalUrl?: string;
  finalUrl?: string;
  status: WebResearchSourceState;
  reason?: string;
  createdAt: string;
  updatedAt: string;
  discoveries: Array<Discovery & { rawHref: string; observationId: string; resultIndex: number }>;
  passages: Passage[];
  extraction?: SourceExtraction;
  contentHash?: string;
  completeness?: 'complete' | 'truncated' | 'unknown';
  receivedBytes?: number;
  contentType?: string;
  statusCode?: number;
  redirectChain?: import('./webResearch').RedirectHop[];
  /** Page-declared HTTP(S) icon URL. Kept small and fetched only when the renderer asks for it. */
  siteIconUrl?: string;
  pendingReanalysis?: boolean;
};

export type WebResearchCounts = {
  discoveries: number;
  sources: number;
  queued: number;
  fetching: number;
  extracting: number;
  completed: number;
  failed: number;
  cancelled: number;
  unprocessed: number;
  processed: number;
  evidenceReady: number;
  irrelevant: number;
  claims: number;
  evidence: number;
};

export type WebResearchSiteSummary = {
  domain: string;
  sourceCount: number;
  processed: number;
  iconAvailable: boolean;
};

export type WebResearchTaskSnapshot = {
  researchRunId: string;
  threadId: string;
  originalQuestion: string;
  revision: number;
  status: WebResearchTaskState;
  statusReason?: string;
  reportPath?: string;
  createdAt: string;
  updatedAt: string;
  budget: ResearchBudget;
  usage: ResearchUsage;
  counts: WebResearchCounts;
  sites: WebResearchSiteSummary[];
};

export const DEFAULT_WEB_RESEARCH_TASK_BUDGET: Readonly<ResearchBudget> = Object.freeze({
  maxCandidates: 1000,
  maxFetches: 300,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxBytesPerSource: 12 * 1024 * 1024,
  maxModelCalls: 1800,
  maxOutputTokensPerCall: 1536,
  maxRedirectsPerSource: 8,
  fetchConcurrency: 12,
  modelConcurrency: 4,
});
