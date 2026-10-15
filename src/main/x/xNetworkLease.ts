import { randomUUID } from 'node:crypto';
import { KydogError } from '../../shared/errors';
import type { BrowserLocationFacts } from '../browser/browserService';
import type {
  BrowserNetworkEvent,
  BrowserNetworkLease,
  BrowserNetworkRequest,
} from '../browser/networkResponses';
import type { XSearchQuery } from './xResearchTypes';
import {
  decodeXSearchResponse,
  type XNetworkPage,
  type XNetworkProvenance,
  type XSearchNetworkRequest,
} from './xNetworkSource';
export type XNetworkCleanupFailure = 'network_cleanup_failed';
const cleanupFailures = new WeakSet<object>();
export function retainXNetworkCleanupFailure(error: unknown): void {
  if(error!==null&&(typeof error==='object'||typeof error==='function'))cleanupFailures.add(error);
}
export function getXNetworkCleanupFailure(error: unknown): XNetworkCleanupFailure | undefined {
  return error!==null&&(typeof error==='object'||typeof error==='function')&&cleanupFailures.has(error) ? 'network_cleanup_failed' : undefined;
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
}
/** Trusted synchronous historical-fact sink; never grants page action authority. */
export type XNetworkAcceptanceSink = (page: XNetworkPage, fact: XNetworkPageFact) => void;
const same = (a: BrowserLocationFacts, b: BrowserLocationFacts) =>
  a.currentUrl === b.currentUrl &&
  a.documentEpoch === b.documentEpoch &&
  a.routeRevision === b.routeRevision &&
  a.navigationSequence === b.navigationSequence;
/** A request-time binding, separate from DOM generations and navigation receipt UUIDs. */
export class XNetworkSearchLease {
  readonly id = randomUUID();
  readonly pageFacts: XNetworkPageFact[] = [];
  private source?: BrowserNetworkLease;
  private location?: BrowserLocationFacts;
  private navigationId?: string;
  private readonly requests = new Map<
    string,
    { raw: BrowserNetworkRequest; request: XSearchNetworkRequest }
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
  private queued: BrowserNetworkEvent[] = [];
  constructor(
    readonly query: XSearchQuery,
    readonly expectedUrl: string,
  ) {}
  bind(source: BrowserNetworkLease): void {
    if (this.source) throw new Error('lease_already_bound');
    this.source = source;
  }
  accepts = (raw: BrowserNetworkRequest): boolean => {
    if (
      this.stopped ||
      this.ended ||
      this.pageFacts.length >= 1000 ||
      raw.isMainFrame !== true ||
      raw.sessionId !== null ||
      raw.redirectIndex < 0 ||
      !raw.navigationId ||
      raw.location.currentUrl !== this.expectedUrl ||
      raw.method !== 'GET'
    )
      return false;
    if (
      this.location &&
      (!same(this.location, raw.location) ||
        this.navigationId !== raw.navigationId)
    )
      return false;
    let vars: Record<string, unknown>;
    try {
      const url = new URL(raw.url);
      if (
        url.protocol !== 'https:' ||
        url.hostname !== 'x.com' ||
        url.port ||
        url.username ||
        url.password ||
        !/^\/i\/api\/graphql\/[^/]+\/SearchTimeline$/.test(url.pathname) ||
        url.searchParams.getAll('variables').length !== 1
      )
        return false;
      vars = JSON.parse(url.searchParams.get('variables')!);
    } catch {
      return false;
    }
    if (
      !vars ||
      vars.rawQuery !== this.query.query ||
      vars.product !== this.query.product
    )
      return false;
    const input = Object.hasOwn(vars, 'cursor') ? vars.cursor : null;
    if (input !== null && (typeof input !== 'string' || !input)) return false;
    if (this.initial && input === null) return false;
    if (!this.initial && this.requests.size === 0 && input !== null)
      return false;
    if (!this.requests.size && this.initial && input !== this.cursor)
      return false;
    if (
      [...this.requests.values()].some((p) => p.request.inputCursor === input)
    )
      return false;
    this.location ??= { ...raw.location };
    this.navigationId ??= raw.navigationId;
    const provenance: XNetworkProvenance = {
      leaseId: this.id,
      requestRef: randomUUID(),
      navigationId: raw.navigationId,
      documentEpoch: raw.location.documentEpoch,
      routeRevision: raw.location.routeRevision,
      navigationSequence: raw.location.navigationSequence,
      operation: 'SearchTimeline',
      observedAt: new Date().toISOString(),
    };
    this.requests.set(raw.id, {
      raw: Object.freeze({
        ...raw,
        location: Object.freeze({ ...raw.location }),
      }),
      request: {
        provenance,
        query: { ...this.query },
        inputCursor: input as string | null,
      },
    });
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
    onAccepted?: XNetworkAcceptanceSink,
  ): Promise<{
    pages: XNetworkPage[];
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
    const pages: XNetworkPage[] = [];
    const facts: XNetworkPageFact[] = [];
    const validSource = () => {
      try {
        if (signal?.aborted) { this.stopped='cancelled'; return false; }
        const current=currentLocation?.() ?? location;
        if(!same(location,current)||(this.location&&!same(this.location,current))) { this.stopped='generation_changed'; return false; }
        return true;
      } catch { this.stopped=signal?.aborted?'cancelled':'generation_changed'; return false; }
    };
    const consume = (events: BrowserNetworkEvent[]) => {
      if(!validSource())return;
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
          this.stopped = 'http_status';
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
        if (!pair) break;
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
        if(!validSource())break;
        let page: XNetworkPage;
        try { page = decodeXSearchResponse(body, bound.request); }
        catch { this.stopped='decode_failed'; break; }
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
        };
        this.pageFacts.push(fact);
        facts.push(fact);
        pages.push(page);
        this.proof = page.provenance;
        this.initial = true;
        // Commit evidence before any promise continuation can lose a cancellation race.
        onAccepted?.(page, fact);
        if (page.unsupported.length) {
          this.stopped = 'unsupported_response';
          break;
        }
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
