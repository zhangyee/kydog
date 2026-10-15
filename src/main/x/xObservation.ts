import type { AxSnapshot } from '../browser/snapshot';
import type { XActionResult, XOpenResult, XQueuedPage } from './xResearchBrowser';
import type { XArticleNativeIdentity, XArticleEntry, XControlBinding, XLocationRelation, XResearchStatus, XSafeLocation, XTextObservation, XTruncation, XReplyScope, XReadFrameDiagnostic, XUnscopedPosts } from './xResearchTypes';

export type XPageRequest =
  | { stage: 'search'; expectedUrl: string; query: string; product: 'Top' | 'Latest' }
  | { stage: 'post'; expectedUrl: string; postId: string; directOpen?: XOpenResult }
  | { stage: 'article'; expectedUrl: string; entry: XArticleEntry; via: { kind: 'action'; result: XActionResult } | { kind: 'open'; result: XOpenResult } };
export interface XPageControl { kind: 'body_expand' | 'replies_expand' | 'article_entry'; postId: string | null; binding: XControlBinding; sourceRelation?: 'same_cell' | 'focal_contains_control' | 'control_contains_focal' | 'different_cell' | 'unknown' }
export interface XPageObservation {
  unscopedPosts?: XUnscopedPosts;
  /** Source predicates from this validated collection; never an authorization input. */
  diagnosticFrame?: XReadFrameDiagnostic;
  stage: XPageRequest['stage']; status: XResearchStatus; identityProven: boolean;
  location: { requested: XSafeLocation; current: XSafeLocation; relation: XLocationRelation; documentEpoch: number; routeRevision: number; navigationSequence: number; navigationEvent: string | null };
  root: XTextObservation | null; posts: XTextObservation[]; quotedPosts: XTextObservation[];
  replies: XTextObservation[]; fragments: XTextObservation[];
  article: { nativeIdentity?: XArticleNativeIdentity; title: string; body: XTextObservation; blocks: string[]; links: {url: string | null; text: string; redacted: boolean}[] } | null;
  replyScope?: XReplyScope;
  readonly entryParents: WeakMap<XArticleEntry,XTextObservation>;
  entries: XArticleEntry[]; controls: XPageControl[];
  state: {kind: 'auth_required' | 'explicit_empty'; text: string; observationId: string} | null;
  /** Count of this bounded extractor's items, including quotes/fragments; never a page total. */
  scope: { collectedItemCount: number; regionObserved: boolean; selectedProduct: string | null; replyParent: null; completeness: 'unknown' };
  truncation: XTruncation; controlTruncation: XTruncation;
  /** Trusted main-process only; non-enumerable, never serialize or persist. */
  readonly snapshot: AxSnapshot;
}

/** Public fixed-purpose adapter; the port validates raw DOM before returning. */
export async function collectXPage(page: XQueuedPage, request: XPageRequest): Promise<XPageObservation> {
  return page.collect(request);
}
