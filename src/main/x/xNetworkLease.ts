import { randomUUID } from 'node:crypto';
import { KydogError } from '../../shared/errors';
import { logger } from '../log';
import type { BrowserLocationFacts } from '../browser/browserService';
import type {
  BrowserNetworkEvent,
  BrowserNetworkLease,
  BrowserNetworkRequest,
} from '../browser/networkResponses';
import type { XSearchQuery } from './xResearchTypes';
import {
  decodeXSearchResponse,
  decodeXReadResponse,
  type XReadNetworkRequest,
  type XNetworkReadPage,
  type XNetworkPage,
  type XNetworkProvenance,
  type XSearchNetworkRequest,
} from './xNetworkSource';
export class XNetworkActionPendingError extends KydogError {
  constructor() { super('browser.stale_snapshot', 'X cursor linkage is not yet proven'); }
}
export type XNetworkCleanupFailure = 'network_cleanup_failed';
const cleanupFailures = new WeakSet<object>();
export function retainXNetworkCleanupFailure(error: unknown): void {
  if (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function')
  )
    cleanupFailures.add(error);
}
export function getXNetworkCleanupFailure(
  error: unknown,
): XNetworkCleanupFailure | undefined {
  return error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    cleanupFailures.has(error)
    ? 'network_cleanup_failed'
    : undefined;
}
export interface XNetworkPageFact {
  provenance: XNetworkProvenance;
  bytes: number;
  sha256: string;
  inputCursorRef: string | null;
  outputCursorRef: string | null;
  end: XNetworkPage['end'];
  observed: number;
  sampled: number;
  omitted: number;
  unsupported: string[];
  readContext?: {
    rootPostId: string;
    accountContextId: string | null;
    branchKey: string | null;
    sortKey: string | null;
    continuationKind: string | null;
    terminationDirections: string[];
  };
}
/** Trusted synchronous historical-fact sink; never grants page action authority. */
export type XNetworkAcceptanceSink<Page extends XNetworkPage = XNetworkPage> = (
  page: Page,
  fact: XNetworkPageFact,
) => void;
interface XNetworkStrategy<
  Request extends {
    provenance: XNetworkProvenance;
    inputCursor: string | null;
  },
  Page extends XNetworkPage,
> {
  operation: string;
  bindVariables(
    vars: Record<string, unknown>,
    provenance: XNetworkProvenance,
    inputCursor: string | null,
  ): Request | null;
  decode(body: unknown, request: Request): Page;
  provesIdentity?(page: Page): boolean;
  onInvalidCursor?(): void;
}

/** Finite label for why an operation-matching request was not accepted. */
export type XNetworkRejection =
  | 'lease_stopped' | 'not_main_frame' | 'session_scoped' | 'redirect_unknown'
  | 'navigation_unknown' | 'location_mismatch' | 'method' | 'variables_shape'
  | 'bind_variables' | 'generation_changed' | 'cursor_link'
  | 'duplicate_input_cursor' | 'capture_exhausted'
  /** A cursor answering a control we just dispatched: refused, but not a chain revocation. */
  | 'cursor_link_branch';

const same = (a: BrowserLocationFacts, b: BrowserLocationFacts) =>
  a.currentUrl === b.currentUrl &&
  a.documentEpoch === b.documentEpoch &&
  a.routeRevision === b.routeRevision &&
  a.navigationSequence === b.navigationSequence;
/** A request-time binding, separate from DOM generations and navigation receipt UUIDs. */
export class XNetworkLease<
  Request extends {
    provenance: XNetworkProvenance;
    inputCursor: string | null;
  },
  Page extends XNetworkPage,
> {
  readonly id = randomUUID();
  readonly pageFacts: XNetworkPageFact[] = [];
  private source?: BrowserNetworkLease;
  private actionController = new AbortController();
  /** A native attempt keeps this exact signal even after a later chain resolves. */
  get actionSignal(): AbortSignal { return this.actionController.signal; }
  private updateActionAuthority(): void {
    if (!this.strategy.onInvalidCursor) return;
    const unresolved = [...this.requests.values()].some(p => p.request.inputCursor !== this.cursor);
    if (this.stopped) this.actionController.abort();
    else if (unresolved) this.actionController.abort(new XNetworkActionPendingError());
    else if (this.actionController.signal.aborted) this.actionController = new AbortController();
  }
  private location?: BrowserLocationFacts;
  private navigationId?: string;
  private sourceCoordinates?: { frameId: string; loaderId: string };
  private readonly requests = new Map<
    string,
    { raw: BrowserNetworkRequest; request: Request }
  >();
  private readonly responses = new Map<
    string,
    Extract<BrowserNetworkEvent, { kind: 'response' }>
  >();
  private readonly cursors = new Map<string, string>();
  private cursor: string | null = null;
  private initial = false;
  private ended = false;
  private closing?: Promise<string | null>;
  private proof?: XNetworkProvenance;
  private stopped: string | null = null;
  /** Bounded, token-free visibility of the operation-matching requests this lease saw.
   *  Answers "did X even send the next page, and if so why was it dropped" without
   *  inventing a heuristic from geometry or elapsed time. */
  private readonly sightings = { seen: 0, accepted: 0, rejected: 0, reasons: {} as Record<string, number> };
  /** Last non-200 HTTP fact for this lease: status plus any Retry-After hint. */
  private httpFailure: { status: number; retryAfterMs: number | null } | null = null;
  /** Set just before dispatching a control whose continuation the decoded chain may not
   *  announce (a DOM reply-expansion). Its next reply is refused instead of revoking the
   *  whole lease, so one unprovable branch cannot destroy an otherwise readable target. */
  private branchContinuationExpected = false;
  expectBranchContinuation(): void { this.branchContinuationExpected = true; }
  private queued: BrowserNetworkEvent[] = [];
  private invalidationReason: string | null = null;
  private readonly invalidationListeners = new Set<(reason: string) => void>();
  constructor(
    readonly expectedUrl: string,
    private readonly strategy: XNetworkStrategy<Request, Page>,
  ) {}
  bind(source: BrowserNetworkLease): void {
    if (this.source) throw new Error('lease_already_bound');
    this.source = source;
  }
  onInvalidated(listener: (reason: string) => void): () => void {
    this.invalidationListeners.add(listener);
    if (this.invalidationReason !== null) listener(this.invalidationReason);
    return () => this.invalidationListeners.delete(listener);
  }
  protected invalidate(reason: string): void {
    if (this.invalidationReason !== null) return;
    this.invalidationReason = reason;
    this.stopped = reason;
    this.actionController.abort();
    for (const listener of this.invalidationListeners) listener(reason);
  }
  /** The URL alone names this lease's operation, before variables are validated. */
  private operationUrl(raw: BrowserNetworkRequest): URL | null {
    try {
      const url = new URL(raw.url);
      return url.protocol === 'https:' && url.hostname === 'x.com' && !url.port &&
        !url.username && !url.password &&
        new RegExp('^/i/api/graphql/[^/]+/' + this.strategy.operation + '$').test(url.pathname)
        ? url : null;
    } catch { return null; }
  }
  /** One source fact per operation-matching request; never carries a cursor token. */
  private sighting(accepted: boolean, hasInputCursor: boolean, reason?: XNetworkRejection): void {
    this.sightings.seen++;
    if (accepted) this.sightings.accepted++;
    else {
      this.sightings.rejected++;
      const key = reason ?? 'unknown';
      this.sightings.reasons[key] = (this.sightings.reasons[key] ?? 0) + 1;
    }
    try {
      logger.info('x_research', 'network_lease_request', {
        leaseId: this.id, operation: this.strategy.operation, accepted, hasInputCursor,
        ...(reason ? { reason } : {}),
      });
    } catch { /* Diagnostics cannot change acceptance. */ }
  }
  accepts = (raw: BrowserNetworkRequest): boolean => {
    const url = this.operationUrl(raw);
    if (!url) return false;
    let input: unknown = null;
    const deny = (reason: XNetworkRejection): false => {
      this.sighting(false, input !== null, reason);
      return false;
    };
    if (this.stopped) return deny('lease_stopped');
    if (raw.isMainFrame !== true) return deny('not_main_frame');
    if (raw.sessionId !== null) return deny('session_scoped');
    if (raw.redirectIndex < 0) return deny('redirect_unknown');
    if (!raw.navigationId) return deny('navigation_unknown');
    if (raw.location.currentUrl !== this.expectedUrl) return deny('location_mismatch');
    if (raw.method !== 'GET') return deny('method');
    let vars: Record<string, unknown>;
    try {
      if (url.searchParams.getAll('variables').length !== 1) return deny('variables_shape');
      vars = JSON.parse(url.searchParams.get('variables')!);
    } catch {
      return deny('variables_shape');
    }
    if (!vars || Array.isArray(vars) || typeof vars !== 'object') return deny('variables_shape');
    input = Object.hasOwn(vars, 'cursor') ? vars.cursor : null;
    const provenance: XNetworkProvenance = {
      leaseId: this.id,
      requestRef: randomUUID(),
      navigationId: raw.navigationId,
      documentEpoch: raw.location.documentEpoch,
      routeRevision: raw.location.routeRevision,
      navigationSequence: raw.location.navigationSequence,
      operation: this.strategy.operation,
      observedAt: new Date().toISOString(),
    };
    const request = this.strategy.bindVariables(
      vars,
      provenance,
      input as string | null,
    );
    if (!request) return deny('bind_variables');
    if (
      this.location &&
      (!same(this.location, raw.location) ||
        this.navigationId !== raw.navigationId ||
        this.sourceCoordinates?.frameId !== raw.frameId ||
        this.sourceCoordinates?.loaderId !== raw.loaderId)
    ) {
      this.invalidate('generation_changed');
      return deny('generation_changed');
    }

    if (
      (input !== null && (typeof input !== 'string' || !input)) ||
      (this.initial && input === null) ||
      (!this.initial && this.requests.size === 0 && input !== null) ||
      (!this.requests.size && this.initial && input !== this.cursor)
    ) {
      if (this.branchContinuationExpected) {
        this.branchContinuationExpected = false;
        return deny('cursor_link_branch');
      }
      this.strategy.onInvalidCursor?.();
      return deny('cursor_link');
    }
    if (
      [...this.requests.values()].some((p) => p.request.inputCursor === input)
    )
      return deny('duplicate_input_cursor');

    // Pending captures reserve page slots but do not become accepted evidence.
    if (this.ended || this.pageFacts.length + this.requests.size >= 1000) return deny('capture_exhausted');
    this.location ??= { ...raw.location };
    this.navigationId ??= raw.navigationId;
    this.sourceCoordinates ??= { frameId: raw.frameId, loaderId: raw.loaderId };
    this.requests.set(raw.id, {
      raw: Object.freeze({
        ...raw,
        location: Object.freeze({ ...raw.location }),
      }),
      request,
    });
    this.updateActionAuthority();
    this.sighting(true, input !== null);
    return true;
  };
  private fail(reason: string): never {
    this.stopped = reason;
    if (reason === 'cancelled')
      throw new KydogError('browser.cancelled', 'X collection cancelled');
    throw new KydogError('x.invalid_page', `source_unavailable:${reason}`);
  }
  private ref(cursor: string | null): string | null {
    if (cursor === null) return null;
    let ref = this.cursors.get(cursor);
    if (!ref) {
      ref = randomUUID();
      this.cursors.set(cursor, ref);
    }
    return ref;
  }
  async collect(
    location: BrowserLocationFacts,
    signal?: AbortSignal,
    currentLocation?: () => BrowserLocationFacts,
    onAccepted?: XNetworkAcceptanceSink<Page>,
  ): Promise<{
    pages: Page[];
    proof?: XNetworkProvenance;
    facts: XNetworkPageFact[];
    failure?: string;
    pending: boolean;
  }> {
    if (this.stopped) this.fail(this.stopped);
    if (
      location.currentUrl !== this.expectedUrl ||
      (this.location && !same(this.location, location))
    )
      this.fail('generation_changed');
    if (!this.source) this.fail('lease_missing');
    const pages: Page[] = [];
    const facts: XNetworkPageFact[] = [];
    const validSource = () => {
      try {
        if (this.invalidationReason !== null) return false;
        if (signal?.aborted) {
          this.stopped = 'cancelled';
          return false;
        }
        const current = currentLocation?.() ?? location;
        if (
          !same(location, current) ||
          (this.location && !same(this.location, current))
        ) {
          this.stopped = 'generation_changed';
          return false;
        }
        return true;
      } catch {
        this.stopped = signal?.aborted ? 'cancelled' : 'generation_changed';
        return false;
      }
    };
    const consume = (events: BrowserNetworkEvent[]) => {
      if (!validSource()) return;
      for (const e of events) {
        if (e.kind === 'closed') {
          this.stopped = e.reason;
          continue;
        }
        if (e.kind === 'request') continue;
        const bound = this.requests.get(e.request.id);
        if (!bound) continue;
        if (e.kind === 'failed') {
          this.stopped = e.reason;
          continue;
        }
        if (e.status !== 200) {
          // Keep the protocol fact instead of collapsing every non-200 into one word:
          // the status and any Retry-After decide whether this is rate limiting.
          this.httpFailure = { status: e.status, retryAfterMs: e.retryAfterMs ?? null };
          this.stopped = 'http_status:' + e.status;
          continue;
        }
        if (JSON.stringify(bound.raw) !== JSON.stringify(e.request)) {
          this.stopped = 'request_changed';
          continue;
        }
        this.responses.set(e.request.id, e);
      }
      while (this.pageFacts.length < 1000) {
        const pair = [...this.requests.entries()].find(
          ([, v]) => v.request.inputCursor === this.cursor,
        );
        if (!pair) {
          if (this.requests.size && this.strategy.onInvalidCursor)
            this.strategy.onInvalidCursor();
          break;
        }
        const [id, bound] = pair,
          response = this.responses.get(id);
        if (!response) break;
        let body: unknown;
        try {
          body = JSON.parse(response.body);
        } catch {
          this.stopped = 'invalid_json';
          break;
        }
        if (!validSource()) break;
        let page: Page;
        try {
          page = this.strategy.decode(body, bound.request);
        } catch {
          this.stopped = 'decode_failed';
          break;
        }
        this.requests.delete(id);
        this.responses.delete(id);
        const fact: XNetworkPageFact = {
          provenance: { ...page.provenance },
          bytes: response.bytes,
          sha256: response.sha256,
          inputCursorRef: this.ref(page.inputCursor),
          outputCursorRef: this.ref(page.outputCursor),
          end: page.end,
          observed: page.posts.length,
          sampled: page.posts.length,
          omitted: 0,
          unsupported: [...page.unsupported],
          ...('root' in page
            ? {
                readContext: {
                  rootPostId: (bound.request as unknown as XReadNetworkRequest)
                    .postId,
                  accountContextId: null,
                  branchKey: (page as unknown as XNetworkReadPage).branchKey,
                  sortKey: (page as unknown as XNetworkReadPage).sortKey,
                  continuationKind: (page as unknown as XNetworkReadPage)
                    .continuationKind,
                  terminationDirections: (page as unknown as XNetworkReadPage)
                    .terminationDirections,
                },
              }
            : {}),
        };
        this.pageFacts.push(fact);
        facts.push(fact);
        pages.push(page);
        if (!this.strategy.provesIdentity || this.strategy.provesIdentity(page))
          this.proof = page.provenance;
        this.initial = true;
        // Commit evidence before any promise continuation can lose a cancellation race.
        onAccepted?.(page, fact);
        // An unrecorded shape inside an otherwise accepted page is retained on
        // the page fact and forces end='unknown' in the decoder, but it must not
        // abort the chain: the design stops on budget or an exhausted wait, and
        // a page can still carry a valid cursor. A page without a usable cursor
        // is stopped by the cursor_not_advanced branch below.
        if (page.end === 'cursor_exhausted') {
          this.ended = true;
          break;
        }
        if (page.outputCursor === null || page.outputCursor === this.cursor) {
          this.stopped = 'cursor_not_advanced';
          break;
        }
        this.cursor = page.outputCursor;
      }
      this.updateActionAuthority();
    };
    consume([...this.queued, ...(await this.source.drain())]);
    this.queued = [];
    // A receipt cannot outrun bodies of requests already bound to this lease.
    // The timeout is a wait outcome, never a chain exhaustion heuristic.
    const deadline = Date.now() + 8000;
    while (
      this.requests.size &&
      pages.length === 0 &&
      !this.stopped &&
      !this.ended &&
      this.pageFacts.length < 1000
    ) {
      if (signal?.aborted) {
        this.stopped = 'cancelled';
        break;
      }
      if (
        this.initial &&
        ![...this.requests.values()].some(
          (p) => p.request.inputCursor === this.cursor,
        )
      ) {
        this.stopped = 'cursor_chain_mismatch';
        break;
      }
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('timeout');
        consume([await this.source.take(signal, remaining)]);
      } catch {
        this.stopped = signal?.aborted ? 'cancelled' : 'wait_timeout';
      }
    }
    if (this.stopped && !this.proof) this.fail(this.stopped);
    try {
      logger.info('x_research', 'network_lease_collect', {
        leaseId: this.id, operation: this.strategy.operation, ...this.sightings,
        pages: pages.length, pending: this.requests.size > 0 && !this.stopped && !this.ended,
        ...(this.stopped ? { stopped: this.stopped } : {}),
        ...(this.httpFailure ? { httpStatus: this.httpFailure.status, retryAfterMs: this.httpFailure.retryAfterMs } : {}),
      });
    } catch { /* Diagnostics cannot change collection. */ }
    return {
      pages,
      pending: this.requests.size > 0 && !this.stopped && !this.ended,
      proof: this.proof,
      facts,
      ...(this.stopped ? { failure: this.stopped } : {}),
    };
  }
  async wait(
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!this.source || this.stopped) return false;
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const event = await this.source.take(
          signal,
          Math.max(1, deadline - Date.now()),
        );
        this.queued.push(event);
        if (event.kind !== 'request') return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  close(): Promise<string | null> {
    if (this.closing) return this.closing;
    this.stopped ??= 'closed';
    this.actionController.abort();
    this.requests.clear();
    this.responses.clear();
    this.queued = [];
    this.cursors.clear();
    return (this.closing = (async () => {
      try {
        await this.source?.close('x_collection_finished');
        return null;
      } catch {
        return 'network_cleanup_failed';
      }
    })());
  }
}

export class XNetworkSearchLease extends XNetworkLease<
  XSearchNetworkRequest,
  XNetworkPage
> {
  constructor(
    readonly query: XSearchQuery,
    expectedUrl: string,
  ) {
    super(expectedUrl, {
      operation: 'SearchTimeline',
      bindVariables: (vars, provenance, inputCursor) =>
        vars.rawQuery === query.query && vars.product === query.product
          ? { provenance, query: { ...query }, inputCursor }
          : null,
      decode: (body, request) => decodeXSearchResponse(body, request),
    });
  }
}
export class XNetworkReadLease extends XNetworkLease<
  XReadNetworkRequest,
  XNetworkReadPage
> {
  constructor(
    readonly postId: string,
    expectedUrl: string,
    readonly collectReplies: boolean,
  ) {
    let sortKey: string | null = null,
      branchKey: string | null = null;
    super(expectedUrl, {
      operation: 'TweetDetail',
      provesIdentity: (page) => !!page.root,
      onInvalidCursor: () => this.invalidate('cursor_chain_mismatch'),
      bindVariables: (vars, provenance, inputCursor) => {
        if (vars.focalTweetId !== postId) return null;
        if (
          !['Relevance', 'Recency'].includes(String(vars.rankingMode)) ||
          (sortKey !== null && vars.rankingMode !== sortKey)
        ) {
          this.invalidate('sort_changed');
          return null;
        }
        sortKey = String(vars.rankingMode);
        return {
          provenance,
          postId,
          inputCursor,
          branchKey,
          sortKey,
          collectReplies,
        };
      },
      decode: (body, request) => {
        // Source cursor transition, including out-of-order response completion. A Bottom
        // continuation inside ShowMoreThreads retains that branch; it is not global main.
        const page = decodeXReadResponse(body, { ...request, branchKey });
        if (page.continuationKind === 'ShowMoreThreads')
          branchKey = 'ShowMoreThreads';
        return page;
      },
    });
  }
}
