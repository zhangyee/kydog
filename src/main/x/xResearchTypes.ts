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
interface XTextBase {
  observationId: string;
  sourceKind: 'rendered_ui';
  sourceUrl: string | null;
  author: XAuthorIdentity | null;
  text: string;
  observedAt: string;
  truncation: XTruncation;
}
export type XTextObservation = XTextBase & (
  | { containerKind: 'root_post' | 'quoted_post' | 'reply'; postId: string }
  | { containerKind: 'article' | 'unattributed_fragment'; postId: string | null }
);
export interface XAccessBarrier { status: XResearchStatus; reason: string; observationId: string | null }
export interface XArticleEntry { sourceUrl: string; label: string | null; observationId: string }
export interface XArticleFacts {
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
  requested: XSafeLocation;
  committed: XSafeLocation | null;
  subsequent: XSafeLocation | null;
  relation: XLocationRelation;
  documentGeneration: string | null;
  navigationEvent: string | null;
}
export interface XSearchObservation {
  query: XSearchQuery;
  status: XResearchStatus;
  posts: XTextObservation[];
  stopReason: XStopReason;
  budgetUsage: XBudgetUsage;
  location: XLocationFacts | null;
  barrier: XAccessBarrier | null;
}
export interface XReadObservation {
  target: XReadTarget;
  postId: string | null;
  inputUrl: string | null;
  sourceUrl: string | null;
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
interface XResultBase {
  schemaVersion: 2;
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
