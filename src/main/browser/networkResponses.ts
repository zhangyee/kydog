import { createHash, randomUUID } from 'node:crypto';
import type { Debugger, Event } from 'electron';
import type { BrowserLocationFacts } from './browserService';

/** Private, transient HTTP facts. Never serialize these into logs or public DTOs. */
export interface BrowserNetworkRequest {
  id: string; requestId: string; sessionId: string | null;
  /** Zero-based only for a fully observed chain; -1 means its prefix was not observed. */
  redirectIndex: number;
  loaderId: string; frameId: string;
  /** CDP document tuple [sessionId, frameId, loaderId], NOT NavigationObservation's UUID.
   * Empty means the frame/loader association was unknown when the request arrived. */
  navigationId: string;
  location: BrowserLocationFacts; url: string; method: string; postData?: string;
}
export type BrowserNetworkEvent =
  | { kind: 'request'; request: BrowserNetworkRequest }
  | { kind: 'response'; request: BrowserNetworkRequest; status: number; body: string; bytes: number; sha256: string }
  | { kind: 'failed'; request: BrowserNetworkRequest; reason: 'loading_failed' | 'body_unavailable' | 'body_limit' }
  | { kind: 'closed'; reason: string };
export interface BrowserNetworkSpec { ownerId: string; accepts: (request: BrowserNetworkRequest) => boolean }
export interface BrowserNetworkLease {
  id: string; tabId: string;
  take(signal: AbortSignal | undefined, timeoutMs: number): Promise<BrowserNetworkEvent>;
  drain(): Promise<BrowserNetworkEvent[]>;
  close(reason: string): Promise<void>;
}
const TOTAL_BYTES = 67108864;
const BODY_BYTES = 16777216;
const POST_BYTES = 65536;
type Pending = { request: BrowserNetworkRequest; status?: number; reading: boolean; bytes: number };
type Waiter = { finish: (event: BrowserNetworkEvent) => void };

/** Uses the already attached debugger owned exclusively by BrowserService. */
export class NetworkResponseObserver {
  readonly lease: BrowserNetworkLease;
  private closed: string | null = null;
  private queue: Array<{ event: BrowserNetworkEvent; bytes: number }> = [];
  private queueBytes = 0;
  private requestSequence = 0;
  private pendingBytes = 0;
  private redirectBytes = 0;
  private readonly requests = new Map<string, Pending>();
  private readonly redirects = new Map<string, number>();
  private readonly frames = new Map<string, string>();
  private readonly reads = new Set<Promise<void>>();
  private readonly waiters = new Set<Waiter>();
  private finishClosed!: () => void;
  private readonly closedPromise = new Promise<void>(resolve => { this.finishClosed = resolve; });

  constructor(private readonly debugger_: Debugger, tabId: string, private readonly spec: BrowserNetworkSpec,
    private readonly location: () => BrowserLocationFacts, private readonly onClose: () => void = () => {}) {
    this.lease = { id: randomUUID(), tabId, take: (signal, timeout) => this.take(signal, timeout),
      drain: () => this.drain(), close: reason => this.close(reason) };
  }

  async enable(): Promise<void> {
    if (this.closed !== null) return;
    this.debugger_.on('message', this.message);
    try {
      await Promise.race([this.debugger_.sendCommand('Page.enable'), this.closedPromise]);
      if (this.closed !== null) return;
      const tree = await Promise.race([this.debugger_.sendCommand('Page.getFrameTree'), this.closedPromise]);
      if (this.closed !== null) return;
      const visit = (node: { frame: { id: string; loaderId: string }; childFrames?: typeof node[] }) => {
        const key = JSON.stringify([null, node.frame.id]);
        if (!this.frames.has(key)) this.frames.set(key, node.frame.loaderId);
        node.childFrames?.forEach(visit);
      };
      if (tree.frameTree) visit(tree.frameTree);
      await Promise.race([this.debugger_.sendCommand('Network.enable', {
        maxTotalBufferSize: TOTAL_BYTES, maxResourceBufferSize: BODY_BYTES, maxPostDataSize: POST_BYTES,
      }), this.closedPromise]);
    } catch (error) { await this.close('enable_failed'); throw error; }
  }

  private readonly message = (_event: Event, method: string, p: Record<string, any>, session?: string): void => {
    if (this.closed !== null) return;
    // Electron 41 emits '' for the root session, but rejects it as a command session.
    const sessionId = session === '' || session === undefined ? null : session;
    if (method === 'Page.frameNavigated') {
      this.frames.set(JSON.stringify([sessionId, p.frame.id]), p.frame.loaderId); return;
    }
    if (method === 'Page.frameDetached') { this.frames.delete(JSON.stringify([sessionId, p.frameId])); return; }
    if (typeof p.requestId !== 'string') return;
    const key = JSON.stringify([sessionId, p.requestId]);
    if (method === 'Network.requestWillBeSent') {
      const previous = this.requests.get(key);
      if (previous && p.redirectResponse) this.push({ kind: 'failed', request: previous.request, reason: 'body_unavailable' });
      if (this.closed !== null) return;
      const priorIndex = this.redirects.get(key);
      const redirectIndex = p.redirectResponse ? (priorIndex !== undefined && priorIndex >= 0 ? priorIndex + 1 : -1) : 0;
      this.dropRedirect(key);
      this.redirects.set(key, redirectIndex); this.redirectBytes += Buffer.byteLength(key) + 8;
      this.dropRequest(key);
      if (!this.withinBudget()) return;
      const frameId = typeof p.frameId === 'string' ? p.frameId : '';
      const loaderId = typeof p.loaderId === 'string' ? p.loaderId : '';
      const request: BrowserNetworkRequest = Object.freeze({
        id: JSON.stringify([this.lease.id, sessionId, p.requestId, redirectIndex, ++this.requestSequence]), requestId: p.requestId, sessionId, redirectIndex,
        frameId, loaderId, navigationId: frameId && loaderId && this.frames.get(JSON.stringify([sessionId, frameId])) === loaderId
          ? JSON.stringify([sessionId, frameId, loaderId]) : '',
        location: Object.freeze({ ...this.location() }), url: p.request.url, method: p.request.method,
        ...(typeof p.request.postData === 'string' ? { postData: p.request.postData } : {}),
      });
      let accepted: boolean;
      try { accepted = this.spec.accepts(request); } catch { void this.close('accept_failed'); return; }
      if (!accepted) return;
      this.push({ kind: 'request', request });
      if (this.closed !== null) return;
      if (p.request.hasPostData && !Object.hasOwn(p.request, 'postData') || Buffer.byteLength(request.postData ?? '') > POST_BYTES) {
        this.push({ kind: 'failed', request, reason: 'body_limit' }); return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(request));
      this.pendingBytes += bytes;
      this.requests.set(key, { request, reading: false, bytes });
      this.withinBudget();
    } else if (method === 'Network.responseReceived') {
      const pending = this.requests.get(key);
      if (pending) pending.status = p.response.status;
    } else if (method === 'Network.loadingFailed') {
      const pending = this.requests.get(key);
      if (pending) this.push({ kind: 'failed', request: pending.request, reason: 'loading_failed' });
      this.dropRequest(key); this.dropRedirect(key);
    } else if (method === 'Network.loadingFinished') {
      this.dropRedirect(key);
      const pending = this.requests.get(key);
      if (!pending || pending.reading) return;
      pending.reading = true;
      const observationId = pending.request.id;
      const read = this.readBody(key, observationId, pending.request.requestId, pending.request.sessionId).finally(() => {
        if (this.requests.get(key)?.request.id === observationId) this.dropRequest(key);
        this.reads.delete(read);
      });
      this.reads.add(read);
    }
  };

  private async readBody(key: string, observationId: string, requestId: string, sessionId: string | null): Promise<void> {
    try {
      if (this.requests.get(key)?.status === undefined) throw new Error('missing_response');
      const result = await (sessionId === null
        ? this.debugger_.sendCommand('Network.getResponseBody', { requestId })
        : this.debugger_.sendCommand('Network.getResponseBody', { requestId }, sessionId));
      const pending = this.requests.get(key);
      if (this.closed !== null || !pending || pending.request.id !== observationId) return;
      const request = pending.request;
      if (typeof result.body !== 'string' || typeof result.base64Encoded !== 'boolean') throw new Error('invalid_body');
      const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
      if (bytes.length > BODY_BYTES) { this.push({ kind: 'failed', request, reason: 'body_limit' }); return; }
      const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      // CDP's unencoded string is already decoded. Reject unpaired surrogates rather
      // than silently hashing replacement bytes different from the provided string.
      if (!result.base64Encoded && body !== result.body) throw new Error('lossy_body');
      this.push({ kind: 'response', request, status: pending.status!, body, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    } catch {
      const pending = this.requests.get(key);
      if (this.closed === null && pending?.request.id === observationId) this.push({ kind: 'failed', request: pending.request, reason: 'body_unavailable' });
    }
  }

  private dropRequest(key: string): void {
    this.pendingBytes -= this.requests.get(key)?.bytes ?? 0; this.requests.delete(key);
  }
  private dropRedirect(key: string): void {
    if (this.redirects.delete(key)) this.redirectBytes -= Buffer.byteLength(key) + 8;
  }
  private withinBudget(): boolean {
    if (this.queueBytes + this.pendingBytes + this.redirectBytes <= TOTAL_BYTES) return true;
    void this.close('buffer_limit'); return false;
  }

  private push(event: BrowserNetworkEvent): void {
    if (this.closed !== null) return;
    const waiter = this.waiters.values().next().value as Waiter | undefined;
    if (waiter) { waiter.finish(event); return; }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (this.queueBytes + this.pendingBytes + this.redirectBytes + bytes > TOTAL_BYTES) { void this.close('buffer_limit'); return; }
    this.queue.push({ event, bytes }); this.queueBytes += bytes;
  }

  private take(signal: AbortSignal | undefined, timeoutMs: number): Promise<BrowserNetworkEvent> {
    if (signal?.aborted) void this.close('cancelled');
    if (this.closed !== null) return Promise.resolve({ kind: 'closed', reason: this.closed });
    const queued = this.queue.shift();
    if (queued) { this.queueBytes -= queued.bytes; return Promise.resolve(queued.event); }
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.waiters.delete(waiter); };
      const waiter: Waiter = { finish: event => { cleanup(); resolve(event); } };
      const abort = () => { void this.close('cancelled'); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('network_response_timeout')); }, timeoutMs);
      this.waiters.add(waiter); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private async drain(): Promise<BrowserNetworkEvent[]> {
    // Snapshot already-associated reads; later unrelated traffic cannot starve drain.
    await Promise.race([Promise.allSettled([...this.reads]), this.closedPromise]);
    const events = this.queue.map(q => q.event); this.queue = []; this.queueBytes = 0; return events;
  }

  async close(reason: string): Promise<void> {
    if (this.closed !== null) return;
    this.closed = reason;
    this.debugger_.off('message', this.message);
    this.queue = []; this.queueBytes = 0; this.pendingBytes = 0; this.redirectBytes = 0; this.requests.clear(); this.redirects.clear(); this.frames.clear(); this.reads.clear();
    for (const waiter of [...this.waiters]) waiter.finish({ kind: 'closed', reason });
    this.finishClosed(); this.onClose();
    // Do not detach, disable a shared domain, or remove another owner's listeners.
  }
}
