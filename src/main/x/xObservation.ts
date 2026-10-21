import type { AxSnapshot } from '../browser/snapshot';
import type { XActionResult, XOpenResult, XQueuedPage } from './xResearchBrowser';
import type { XArticleNativeIdentity, XArticleEntry, XControlBinding, XLocationRelation, XResearchStatus, XSafeLocation, XTextObservation, XTruncation, XReplyScope, XReadFrameDiagnostic, XUnscopedPosts } from './xResearchTypes';

export type XPageRequest =
  | { stage: 'search'; expectedUrl: string; query: string; product: 'Top' | 'Latest' }
  | { stage: 'post'; expectedUrl: string; postId: string; collectReplies?: boolean; directOpen?: XOpenResult }
  | { stage: 'article'; expectedUrl: string; entry: XArticleEntry; via: { kind: 'action'; result: XActionResult } | { kind: 'open'; result: XOpenResult } };
export interface XPageControl { kind: 'body_expand' | 'replies_expand' | 'article_entry'; postId: string | null; binding: XControlBinding; sourceRelation?: 'same_cell' | 'focal_contains_control' | 'control_contains_focal' | 'different_cell' | 'unknown' }
export interface XPageObservation {
  network?: {pages: import('./xNetworkSource').XNetworkPage[];proof:import('./xNetworkSource').XNetworkProvenance;facts?:import('./xNetworkLease').XNetworkPageFact[];failure?:string;pending?:boolean};
  unscopedPosts?: XUnscopedPosts;
  /** Source predicates from this validated collection; never an authorization input. */
  diagnosticFrame?: XReadFrameDiagnostic;
  stage: XPageRequest['stage']; status: XResearchStatus; identityProven: boolean;
  location: { requested: XSafeLocation; current: XSafeLocation; relation: XLocationRelation; documentEpoch: number; routeRevision: number; navigationSequence: number; navigationEvent: string | null };
  root: XTextObservation | null; posts: XTextObservation[]; quotedPosts: XTextObservation[];
  replies: XTextObservation[]; fragments: XTextObservation[];
  article: { nativeIdentity?: XArticleNativeIdentity; title: string; body: XTextObservation; blocks: string[]; links: {url: string | null; text: string; redacted: boolean}[] } | null;
  replyScope?: XReplyScope;
  /** Complete native Article scan only; private and non-enumerable, never an action capability. */
  readonly articleParentInventories:ReadonlyMap<number,{postId:string;sourceUrl:string;authorHandle:string;observedEntries:number;unresolvedEntries:number}>;
  readonly entryParents: WeakMap<XArticleEntry,{postId:string;sourceUrl:string;authorHandle:string}>;
  entries: XArticleEntry[]; controls: XPageControl[];
  state: {kind: 'auth_required' | 'explicit_empty'; text: string; observationId: string} | null;
  /** Count of this bounded extractor's items, including quotes/fragments; never a page total. */
  scope: { collectedItemCount: number; regionObserved: boolean; replyParent: null; completeness: 'unknown' };
  truncation: XTruncation; controlTruncation: XTruncation;
  /** Trusted main-process only; non-enumerable, never serialize or persist. */
  readonly snapshot: AxSnapshot;
}

/** Public fixed-purpose adapter; the port validates raw DOM before returning. */
export async function collectXPage(page: XQueuedPage, request: XPageRequest): Promise<XPageObservation> {
  return page.collect(request);
}
