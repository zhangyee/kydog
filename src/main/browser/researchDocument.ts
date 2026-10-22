import { VERIFICATION_WIDGET_SELECTOR } from '../webResearch/verificationWidget';
import { randomUUID } from 'node:crypto';
import SOURCE from './injected/researchDocument.js?raw';
import type { ResearchDocumentSnapshot, ResearchDocumentIdentity } from '../webResearch/browserReadTypes';
export type ResearchDocumentCapture = { revision: number; mainStatusCode?: number; verificationWidget?: boolean } & (
  | { status: 'snapshot'; document: ResearchDocumentSnapshot }
  | { status: 'pending' | 'invalidated'; reason: string }
  | { status: 'oversize'; utf8Bytes: number }
);
/** An exact native/document identity invalidation during observer setup. */
export class ResearchDocumentInvalidatedError extends Error {
  constructor(readonly reason: 'document_navigation' | 'document_identity_changed' | 'document_destroyed') {
    super(reason); this.name = 'ResearchDocumentInvalidatedError';
  }
}
export interface ResearchDocumentLease {
  capture(maxBytes: number): Promise<ResearchDocumentCapture>;
  waitForChange(afterRevision: number): Promise<void>;
  dispose(): Promise<void>;
}
export interface ResearchDocumentPort {
  location(): ResearchDocumentIdentity & { currentUrl: string; mainStatusCode?: number };
  sendCommand(method: string, params?: Record<string, unknown>): Promise<any>;
  subscribe(listener: (method: string, params: Record<string, any>, sessionId?: string) => void): () => void;
  subscribeInvalidation(listener: (reason: string) => void): () => void;
}
/** CDP supplies executionContextId; page-controlled payloads never choose it. */
export async function observeResearchDocument(port: ResearchDocumentPort, signal: AbortSignal): Promise<ResearchDocumentLease> {
  const initial = port.location();
  const token = randomUUID(), worldName = `kydog.research.${token}`, bindingName = `kydogResearch_${token.replaceAll('-', '')}`;
  let contextId: number | undefined, frameId: string | undefined;
  let revision = 0, invalidated: string | undefined, cleanup: Promise<void> | undefined;
  let bindingAdded = false, observed = false;
  let setup: Promise<void> | undefined;
  const waiters = new Set<{ after: number; resolve: () => void }>();
  const wake = () => {
    for (const waiter of waiters) if (invalidated || revision > waiter.after) {
      waiters.delete(waiter); waiter.resolve();
    }
  };
  const sameLocation = () => {
    try {
      const now = port.location();
      return now.currentUrl === initial.currentUrl && now.documentEpoch === initial.documentEpoch
        && now.routeRevision === initial.routeRevision && now.navigationSequence === initial.navigationSequence;
    } catch { return false; }
  };
  const expression = (op: string, extra = {}) => `(${SOURCE})(${JSON.stringify({ op, token, url: initial.currentUrl, ...extra })})`;
  const evaluate = async (op: string, extra = {}) => {
    const raw = await port.sendCommand('Runtime.evaluate', {
      expression: expression(op, extra), contextId, returnByValue: true, awaitPromise: false,
    });
    if (raw?.exceptionDetails || !raw?.result || raw.result.value === undefined) throw new Error('research_document_evaluation_failed');
    return raw.result.value;
  };
  const dispose = (): Promise<void> => {
    if (cleanup) return cleanup;
    invalidated ??= 'disposed';
    wake();
    unsubscribe(); unsubscribeInvalidation(); signal.removeEventListener('abort', abort);
    cleanup = (async () => {
      await setup?.catch(() => {});
      try { if (observed) await evaluate('dispose'); }
      finally { if (bindingAdded) await port.sendCommand('Runtime.removeBinding', { name: bindingName }); }
    })();
    // Invalidation event callbacks cannot await cleanup, but callers can via dispose().
    void cleanup.catch(() => {});
    return cleanup;
  };
  const invalidate = (reason: string) => { invalidated ??= reason; void dispose().catch(() => {}); };
  const abort = () => invalidate('cancelled');
  const unsubscribe = port.subscribe((method, params, sessionId) => {
    if (sessionId || invalidated) return;
    if (method === 'Runtime.executionContextsCleared'
      || method === 'Runtime.executionContextDestroyed' && params.executionContextId === contextId
      || method === 'Page.frameDetached' && params.frameId === frameId
      || method === 'Page.frameNavigated' && params.frame?.id === frameId) {
      invalidate('document_destroyed'); return;
    }
    if (method !== 'Runtime.bindingCalled' || params.name !== bindingName || params.executionContextId !== contextId) return;
    let payload: { token?: unknown; revision?: unknown; url?: unknown };
    try { payload = JSON.parse(params.payload); } catch { return; }
    if (!payload || payload.token !== token || !Number.isSafeInteger(payload.revision) || Number(payload.revision) <= revision) return;
    if (payload.url !== initial.currentUrl || !sameLocation()) { invalidate('document_identity_changed'); return; }
    revision = Number(payload.revision); wake();
  });
  const unsubscribeInvalidation = port.subscribeInvalidation(invalidate);
  signal.addEventListener('abort', abort, { once: true });
  const check = () => {
    if (signal.aborted) invalidate('cancelled');
    if (!sameLocation()) invalidate('document_identity_changed');
    return !invalidated;
  };
  setup = (async () => {
    const active = () => { if (!check()) throw new Error(invalidated); };
    active();
    await port.sendCommand('Runtime.enable'); active();
    await port.sendCommand('Page.enable'); active();
    const tree = await port.sendCommand('Page.getFrameTree'); active();
    frameId = tree?.frameTree?.frame?.id;
    if (typeof frameId !== 'string') throw new Error('research_document_main_frame_missing');
    const world = await port.sendCommand('Page.createIsolatedWorld', { frameId, worldName, grantUniveralAccess: false });
    contextId = world?.executionContextId;
    if (!Number.isSafeInteger(contextId)) throw new Error('research_document_context_missing');
    if (!check()) throw new Error(invalidated);
    // executionContextName scopes future bindings to this uniquely named world;
    // event admission additionally checks the returned context ID and root session.
    // A timed-out command may still complete in Chromium; clean issued resources,
    // not only commands whose acknowledgements arrived before the guard.
    bindingAdded = true;
    await port.sendCommand('Runtime.addBinding', { name: bindingName, executionContextName: worldName });
    active();
    observed = true;
    const ready = await evaluate('observe', { bindingName, verificationSelector: VERIFICATION_WIDGET_SELECTOR });
    if (ready?.status !== 'observing') throw new Error('research_document_evaluation_failed');
    if (ready.url !== initial.currentUrl) invalidate('document_identity_changed');
    active();
    revision = Math.max(revision, ready.revision);
  })();
  try { await setup; } catch (error) {
    const reason = invalidated;
    await dispose().catch(() => {});
    if (reason === 'document_navigation' || reason === 'document_identity_changed' || reason === 'document_destroyed') {
      throw new ResearchDocumentInvalidatedError(reason);
    }
    throw error;
  }
  return {
    async capture(maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('research_document_invalid_budget');
      if (!check()) return { status: 'invalidated', reason: invalidated!, revision };
      const captured = await evaluate('capture', { maxBytes, verificationSelector: VERIFICATION_WIDGET_SELECTOR });
      const facts = { mainStatusCode: initial.mainStatusCode, verificationWidget: captured.verificationWidget === true };
      if (!check() || captured.url !== undefined && captured.url !== initial.currentUrl) {
        invalidate('document_identity_changed');
        return { status: 'invalidated', reason: invalidated!, revision };
      }
      if (!Number.isSafeInteger(captured.revision) || captured.revision < 0) throw new Error('research_document_invalid_revision');
      revision = Math.max(revision, captured.revision); wake();
      if (captured.status === 'snapshot') {
        return { ...facts, status: 'snapshot', revision: captured.revision, document: {
          url: initial.currentUrl, identity: { documentEpoch: initial.documentEpoch, routeRevision: initial.routeRevision, navigationSequence: initial.navigationSequence },
          rootRule: captured.rootRule, html: captured.html, utf8Bytes: captured.utf8Bytes,
          ...(initial.mainStatusCode === undefined ? {} : { mainStatusCode: initial.mainStatusCode }),
        } };
      }
      if (captured.status === 'oversize') return { ...facts, status: 'oversize', revision: captured.revision, utf8Bytes: captured.utf8Bytes };
      if (captured.status === 'pending') return { ...facts, status: 'pending', revision: captured.revision, reason: captured.reason };
      invalidate(captured.reason ?? 'document_invalidated');
      return { status: 'invalidated', reason: invalidated!, revision };
    },
    waitForChange(afterRevision) {
      if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) return Promise.reject(new Error('research_document_invalid_revision'));
      if (!check() || revision > afterRevision) return Promise.resolve();
      return new Promise<void>(resolve => { waiters.add({ after: afterRevision, resolve }); });
    },
    dispose,
  };
}
