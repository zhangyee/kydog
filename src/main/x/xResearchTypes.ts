import type { NavigationObservation } from '../../shared/types';
/** v2 observations describe rendered UI facts, never platform-wide completeness. */
export type XResearchStatus = 'observed' | 'partial' | 'explicit_empty' | 'auth_required' | 'action_required' | 'rate_limited' | 'access_denied' | 'unavailable' | 'cancelled' | 'failed';
export type XStopReason = 'explicit_ui_end' | 'budget_reached' | 'action_failed' | 'navigation_failed' | 'identity_unproven' | 'wait_timeout' | 'access_barrier' | 'cancelled' | 'agent_stopped';
export type XFactRelation = 'same' | 'different' | 'unknown';
export interface XLocationRelation {
  origin: XFactRelation;
  path: XFactRelation;
  postId: XFactRelation;
  query: XFactRelation;
  product: XFactRelation;
  fragment: XFactRelation;
}
export interface XSafeLocation {
  origin: string | null;
  path: string | null;
  q: string | null;
  f: string | null;
  fragment: string | null;
  redacted: boolean;
}
export interface XSearchQuery { id: string; query: string; purpose: string; product: 'Top' | 'Latest' }
export type XReadTarget = { postId: string; url?: never } | { url: string; postId?: never };
export interface XSearchRequest { objective: string; queries: XSearchQuery[]; maxPostsPerQuery: number; maxScrollsPerQuery: number }
export interface XReadRequest {
  objective: string;
  targets: XReadTarget[];
  includeArticle: boolean;
  includeReplies: boolean;
  maxRepliesPerPost: number;
  maxScrollsPerPost: number;
  maxExpandActionsPerPost: number;
}
export type XResearchInput = { tabId?: string; search: XSearchRequest; read?: never } | { tabId: string; read: XReadRequest; search?: never };
export interface XTruncation { returned: number; totalKnown: number | null; truncated: boolean }
export interface XAuthorIdentity { handle: string | null; displayName: string | null; profileUrl: string | null }
/** Public identity only; no action binding or private proof crosses the result boundary. */
export interface XArticleEntryIdentity {
  entryObservationId: string; parentPostId: string; sourceUrl: string; targetUrl: string | null;
}
export interface XArticlePreviewInventory {
  scope:'collection'; observed:number; retained:number; omitted:number;
  /** Actual source preview nodes lacking a validated returned entry; no unsafe URL is retained. */
  unresolved:number;
}
interface XTextBase {
  articlePreviewInventory?: XArticlePreviewInventory;
  articlePreviews?: XArticleEntryIdentity[];
  observationId: string;
  sourceKind: 'rendered_ui';
  sourceUrl: string | null;
  author: XAuthorIdentity | null;
  text: string;
  observedAt: string;
  truncation: XTruncation;
}
export type XTextObservation = XTextBase & (
  | { containerKind: 'root_post' | 'quoted_post'; postId: string }
  | { containerKind: 'reply'; postId: string; directParent: XReplyBranch | null }
  | { containerKind: 'article' | 'unattributed_fragment'; postId: string | null }
);
/** Independent own-container evidence; never a target root, reply, or quote role. */
export type XUnscopedPost = XTextBase & {
  containerKind: 'unscoped_post'; relationToTarget: 'unproven'; observedContainer: 'post';
  postId: string; sourceUrl: string; author: XAuthorIdentity & {handle:string};
};
export interface XUnscopedPosts {
  observations: XUnscopedPost[];
  collection: {
    snapshotId:string;
    document:{epoch:number;routeRevision:number;navigationSequence:number;generation:string};
    location:XSafeLocation;
  };
  inventory:{scope:'collection';observed:number;retained:number;omitted:number;sourceInventoryTruncated:boolean;excludedNestedQuotes:number};
  /** Protective source facts, including own parents with no body. Never budget-optional. */
  previewGaps:{sourceUrl:string;unresolved:number}[];
}
export interface XAccessBarrier { status: XResearchStatus; reason: string; observationId: string | null }
export interface XControlBinding { nodeId: number; index: number; snapshotId: string; generation: string }
export interface XArticleEntry {
  /** Actual parent permalink, independent from the possibly absent entry href. */
  sourceUrl: string; parentPostId: string; targetUrl: string | null;
  author: XAuthorIdentity | null; label: string | null; observationId: string; binding: XControlBinding;
}
export interface XArticleNativeIdentity { kind: 'owned_analytics'; href: string; documentGeneration: string }
export interface XArticleFacts {
  /** Initial direct document open; distinct from a parent-entry action/navigation. */
  provenance?: { kind: 'direct_open'; navigationId: string; bodyObservationId: string; sourceUrl: string; nativeIdentity?: XArticleNativeIdentity };
  /** Retained even when optional entry binding/label is omitted by output budgeting. */
  entryIdentity?: XArticleEntryIdentity;
  location?: XLocationFacts;
  requested: boolean;
  entryObserved: boolean;
  actionAttempted: boolean;
  navigationStarted: boolean;
  bodyObserved: boolean;
  entry: XArticleEntry | null;
  body: XTextObservation | null;
  barrier: XAccessBarrier | null;
}
export interface XReplyBranch { postId: string | null; sourceUrl: string | null }
export interface XReplySort { label: string; value: string | null }
export interface XReplyEndEvidence {
  observationId: string;
  text: string;
  sourceUrl: string;
  observedAt: string;
  rootPostId: string;
  branch: XReplyBranch | null;
  sort: XReplySort | null;
}
interface XReplyScopeBase {
  rootPostId: string | null;
  branch: XReplyBranch | null;
  sort: XReplySort | null;
  stopReason: XStopReason;
  displayedReplyCount: { text: string; value: number | null } | null;
}
export type XReplyScope = XReplyScopeBase & (
  | { completeness: 'unknown'; endEvidence: XReplyEndEvidence | null }
  | { completeness: 'ui_scope_end_observed'; endEvidence: XReplyEndEvidence }
);
export interface XBudgetUsage {
  /** Successfully executed actions only; rejected/failed attempts do not increment these. */
  scrolls: number;
  expandActions: number;
  distinctEntries: number;
  outputBytes: number;
}
export interface XLocationFacts {
  /** Actual open() receipt, null when no navigation result was returned. */
  committedNavigationOutcome: NavigationObservation['outcome']['kind'] | null;
  requested: XSafeLocation;
  committed: XSafeLocation | null;
  subsequent: XSafeLocation | null;
  relation: XLocationRelation;
  documentGeneration: string | null;
  navigationEvent: string | null;
}
export interface XObservedSource {
  urlKind: 'permalink' | 'document'; sourceUrl: string; observationId: string;
  rootObservationId: string | null; observedAt: string; containerKind: XTextObservation['containerKind'] | XUnscopedPost['containerKind'];
  runId: string; callId: string; batchId: string;
  queryId: string | null; query: string | null; purpose: string | null; product: 'Top' | 'Latest' | null;
}
/** Legacy source coordinates can select a new read, but cannot become fresh UI provenance. */
export interface XLegacyObservedSource {
  sourceKind: 'legacy_x_graphql'; urlKind: 'permalink'; sourceUrl: string;
  observationId: null; rootObservationId: null; observedAt: null;
  containerKind: 'root_post' | 'quoted_post' | 'reply';
  runId: null; callId: string | null; batchId: null; sessionEntryId: string | null;
  queryId: string | null; query: string | null; purpose: string | null; product: 'Top' | 'Latest' | null;
}
export type XSourceReference = XObservedSource | XLegacyObservedSource;
export interface XCollectionLocation {
  location: XSafeLocation; documentEpoch: number; routeRevision: number; navigationSequence: number;
  navigationEvent: string | null;
}
export interface XCollectionTransition {
  navigationPhase?: 'initial_post' | 'article' | 'return_post';
  navigationId?: string;
  stage: 'search' | 'post' | 'article'; before: XCollectionLocation; after: XCollectionLocation;
  relation: XLocationRelation; rereadRequested: boolean;
  outcome: 'same_url_generation_changed' | 'route_changed' | 'generation_unchanged' | 'cancelled' | 'repeated_invalidation';
}
export interface XSearchObservation {
  diagnostics?: { version: 1; scroll?: XScrollDiagnostics };
  query: XSearchQuery;
  collectionTransitions: XCollectionTransition[];
  status: XResearchStatus;
  posts: XTextObservation[];
  postObservations?: XTextObservation[];
  stopReason: XStopReason;
  budgetUsage: XBudgetUsage;
  location: XLocationFacts | null;
  barrier: XAccessBarrier | null;
}
export interface XArticlePreviewScopeObservation {
  observationId:string;postId:string;sourceUrl:string;authorHandle:string;
  articlePreviews:XArticleEntryIdentity[];
  articlePreviewInventory:XArticlePreviewInventory;
}
export interface XReadObservation {
  unscopedPosts?: XUnscopedPosts;
  /** Bounded, read-only source facts from this target's actual validated frames and actions. */
  diagnostics?: XReadDiagnostics;
  /** Earlier exact source observations displaced from the current per-post view. */
  bodyObservations?: XTextObservation[];
  bodyObservationsOmitted?: number;
  articlePreviewObservations?:XArticlePreviewScopeObservation[];
  inventoryAuditOmitted?:{count:number;first:Pick<XArticlePreviewScopeObservation,'observationId'|'postId'|'sourceUrl'|'authorHandle'>};
  target: XReadTarget;
  collectionTransitions: XCollectionTransition[];
  documentSource: XObservedSource | null;
  inputKind: 'url' | 'postId';
  inputUrlRedacted: boolean;
  postId: string | null;
  inputUrl: string | null;
  sourceUrl: string | null;
  /** Exact alias used only by bounded output; root retains the literal source URL. */
  sourceUrlReference?: 'root.sourceUrl';
  status: XResearchStatus;
  reason: string | null;
  root: XTextObservation | null;
  quotedPosts: XTextObservation[];
  article: XArticleFacts;
  replies: { requested: boolean; observations: XTextObservation[]; scope: XReplyScope };
  stopReason: XStopReason;
  budgetUsage: XBudgetUsage;
  location: XLocationFacts | null;
  barrier: XAccessBarrier | null;
}
/** Counts cap at 33, meaning at least 33; overflow is ambiguous, never identity proof. */
export interface XSourceRootState {
  anchorSnapshotId: string;
  availability: 'captured' | 'unavailable';
  conversation: {candidates:'none'|'unique'|'multiple'|'unavailable';sameObject:boolean|null;connected:boolean|null;sameDocument:boolean|null;containsRoot:boolean|null};
  root: {connection:'connected'|'detached'|'unavailable';sameDocument:boolean|null;topLevel:boolean|null;ownBoundary:boolean|null;inRoots:boolean|null;inRawPosts:boolean|null;shown:'pass'|'dimensions'|'hidden'|'aria_hidden'|'display_none'|'visibility_hidden'|'collapse'|'unavailable'};
  identity: {members:XSourceIdentityState;coordinates:XSourceIdentityState;owned:boolean|null;rendered:XSourceIdentityState;nameCount:number|null;profileLinkCount:number|null;timestampCount:number|null};
}
export type XSourceIdentityState = 'same'|'changed'|'missing'|'ambiguous'|'unavailable';
export interface XReadFrameDiagnostic {
  sourceEndDetector?: 'not_implemented';
  replyUiInventory?: import('./xReplyUiInventory').XReplyUiInventory;
  sourceRootState?: XSourceRootState;
  stage: 'post';
  snapshotId: string;
  location: XSafeLocation;
  document: { epoch: number; routeRevision: number; navigationSequence: number; generation: string };
  rawUrlMatchesPort: boolean;
  requestPostMatchesLocation: boolean;
  regionObserved: boolean;
  inventory: XTruncation;
  rootCandidateCount: number;
  regionNodeId: number | null;
  rootNodeId: number | null;
  rootRejections: { unnamed: number; authorMismatch: number; permalinkMismatch: number };
  rootIdentityProven: boolean;
  replyCount: number;
  repliesExpandControlCount: number;
  explicitEndObserved: boolean;
}
export interface XScrollReceiptDiagnostic {
  actionIndex: number;
  snapshotId: string;
  generation: string;
  location: XSafeLocation;
  targetKind: 'document' | 'element';
  targetNodeId: number | null;
  /** A relation is unknown unless the same source action proved it. */
  targetContainsHit: boolean | null;
  conversationRelation: 'contains' | 'inside' | 'equal' | 'unrelated' | 'unknown';
  rootRelation: 'contains' | 'inside' | 'equal' | 'unrelated' | 'unknown';
  before: number; after: number; scrollHeight: number; clientHeight: number;
  written: boolean; eventObserved: boolean; frameObserved: boolean;
  state: 'pending' | 'frame_observed' | 'no_movement' | 'invalidated' | 'expired';
}
export interface XScrollDiagnostics { totalAttempts: number; first?: XScrollReceiptDiagnostic; last?: XScrollReceiptDiagnostic; omittedAttempts: number }
export interface XClickFailure {
  actionIndex: number; targetPostId: string; controlKind: 'body_expand' | 'article_entry' | 'replies_expand';
  binding: XControlBinding;
  sourceRelation: 'same_cell' | 'focal_contains_control' | 'control_contains_focal' | 'different_cell' | 'unknown';
  diagnostic: import('../browser/pointerDiagnostic').PointerFailureDiagnostic;
}
/** Inventory of the decoded scoped discussion in one existing collection, never a page total. */
export type XReplyCollectionDiagnostic = {state:'not_observed'|'unavailable'} | {
  state:'captured'; snapshotId:string; generation:string; location:XSafeLocation;
  sourceAvailable:boolean; replyControlCount:number;
  inventory:{state:'unavailable'} | {state:'captured';items:{postId:string;sourceUrl:string}[];total:number;returned:number;omitted:number};
};
export interface XReplyAdmission {state:'consumed';purpose:'replies_expand';binding:XControlBinding}
export interface XReplyExpansionAttempt {
  actionIndex:number;targetPostId:string;binding:XControlBinding;
  admission:XReplyAdmission|{state:'unavailable'};
  outcome:'succeeded'|'failed'|'cancelled';
  caps:{replies:number;scrolls:number;expansions:number};
  /** Usage at action issue/resolution; next collection inventory is recorded separately. */
  usageBefore:{replies:number;scrolls:number;expansions:number};
  usageAfter:{replies:number;scrolls:number;expansions:number};
  before:XReplyCollectionDiagnostic;after:XReplyCollectionDiagnostic;
}
export interface XReplyExpansions {totalAttempts:number;omittedAttempts:number;first?:XReplyExpansionAttempt;last?:XReplyExpansionAttempt}
export interface XPointerPreflight {
 actionIndex:number;targetPostId:string;controlKind:'body_expand'|'article_entry'|'replies_expand';binding:XControlBinding;
 diagnostic:Readonly<import('../browser/pointerPreflightDiagnostic').PointerPreflightDiagnostic>;
}
export interface XReadDiagnostics {
 pointerPreflights?:{totalAttempts:number;omittedAttempts:number;first:XPointerPreflight;last:XPointerPreflight};
  replyExpansions?:XReplyExpansions;
  /** Counts authenticated failed click attempts, independently of all issued actions. */
  clickFailures?: {totalFailures:number; first?:XClickFailure; last?:XClickFailure; omittedFailures:number};
  version: 1;
  initialFrame?: XReadFrameDiagnostic;
  firstAdmittedFrame?: XReadFrameDiagnostic;
  terminalFrame?: XReadFrameDiagnostic;
  readiness?: { collectCount: number; initial: {replyCount:number; expandControlCount:number; explicitEndObserved:boolean}; terminal: {replyCount:number; expandControlCount:number; explicitEndObserved:boolean}; timedOut: boolean };
  scroll?: { totalAttempts: number; first?: XScrollReceiptDiagnostic; last?: XScrollReceiptDiagnostic; omittedAttempts: number };
  pointerFailure?: { actionIndex: number; targetPostId: string; controlKind: 'replies_expand'; sourceRelation: 'same_cell' | 'focal_contains_control' | 'control_contains_focal' | 'different_cell' | 'unknown'; diagnostic: import('../browser/pointerDiagnostic').PointerFailureDiagnostic };
}
/** Exact counts for this one serialized tool call. Unknown reason values include
 * absent reasons and unclassified text; they must never become report prose. */
export interface XReportScopeFacts {
  version: 1;
  operation: 'search' | 'read';
  reasonSource: 'barrier.reason' | 'reason';
  totalRows: number;
  statusCounts: Partial<Record<XResearchStatus, number>>;
  stopReasonCounts: Partial<Record<XStopReason, number>>;
  reasonCounts: Record<string, number>;
  replyScopeCounts: Partial<Record<XReplyScope['completeness'], number>>;
}
interface XResultBase {
  schemaVersion: 2;
  reportScopeFacts?: XReportScopeFacts;
  contentProjection?: 'x_research_projection_v1';
  metadataOmissions?: string[];
  /** Secondary model-content metadata omitted while canonical details retain it. */
  contentMetadataOmissions?: string[];
  sourceKind: 'rendered_ui';
  callId: string;
  batchId: string;
  runId: string;
  browserTabId: string;
  objective: string;
  status: XResearchStatus;
  budgetUsage: XBudgetUsage;
  truncation: XTruncation;
}
export type XResearchResult = XResultBase & (
  | { operation: 'search'; queries: XSearchObservation[] }
  | { operation: 'read'; targets: XReadObservation[] }
);
export const X_RESEARCH_MAX_OUTPUT_BYTES = 1024 * 1024;
