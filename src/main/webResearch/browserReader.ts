import { randomUUID } from 'node:crypto';
import type { BrowserService } from '../browser/browserService';
import { ResearchDocumentInvalidatedError, type ResearchDocumentLease } from '../browser/researchDocument';
import type { BrowserLeaseUnavailable, BrowserReadResult, BrowserReader, BrowserSourceKey, ResearchDocumentSnapshot } from './browserReadTypes';

const abortError = () => new DOMException('Browser read cancelled', 'AbortError');
function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? abortError(); }
function interrupted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // A callback may synchronously cancel and reject before this guard runs.
    void work.catch(() => {});
    return Promise.reject(signal.reason ?? abortError());
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? abortError());
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
// The slot belongs to the process, including independently constructed readers.
let busy = false;
const queue: Array<() => void> = [];
function acquire(signal: AbortSignal): Promise<() => void> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const grant = () => {
      signal.removeEventListener('abort', abort);
      busy = true;
      let released = false;
      resolve(() => { if (released) return; released = true; busy = false; queue.shift()?.(); });
    };
    const abort = () => { const index = queue.indexOf(grant); if (index >= 0) queue.splice(index, 1); reject(signal.reason ?? abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    if (busy) queue.push(grant); else grant();
  });
}
type SourceLease = { key: BrowserSourceKey; leaseId: string; attemptId: string | null; tabId: string; urls: Set<string>; requestedUrl: string; unavailable?: string };
const keyOf = (key: BrowserSourceKey) => JSON.stringify([key.threadId, key.researchRunId, key.sourceId]);
const canonical = (url: string) => new URL(url).href;
function sameDocument(browser: BrowserService, tabId: string, doc: ResearchDocumentSnapshot): boolean {
  const now = browser.locationFacts(tabId);
  return now.currentUrl === doc.url && now.documentEpoch === doc.identity.documentEpoch
    && now.routeRevision === doc.identity.routeRevision && now.navigationSequence === doc.identity.navigationSequence
    && !(now.navigationEvent === 'did-start-navigation' && now.navigationType === 'cross_document');
}

export function createBrowserReader({ browser }: { browser: BrowserService }): BrowserReader {
  const leases = new Map<string, SourceLease>();
  const attempts = new Map<string, AbortController>();
  const operations = new Set<AbortController>();
  const sourceOperations = new Map<string, Set<AbortController>>();
  const lifecycle = new Set<(event: BrowserLeaseUnavailable) => void>();
  let disposed = false;
  const markUnavailable = (tabId: string, reason: string) => {
    for (const [id, lease] of leases) if (lease.tabId === tabId && !lease.unavailable) {
      lease.unavailable = reason;
      for (const listener of lifecycle) {
        try { listener({ ...lease.key, leaseId: lease.leaseId, attemptId: lease.attemptId, reason }); } catch { /* One owner observer cannot hide another observer's source fact. */ }
      }
      attempts.get(id)?.abort(new Error(reason));
    }
  };
  const offGone = browser.onTabDestroyed((id, reason) => markUnavailable(id, reason));
  const offUnavailable = browser.onTabUnavailable((id, reason) => markUnavailable(id, `renderer_crashed:${reason}`));
  function current(key: BrowserSourceKey): SourceLease | undefined {
    const lease = leases.get(keyOf(key));
    return lease && !lease.unavailable && browser.researchTabStatus(lease.tabId, key.threadId) === 'available' ? lease : undefined;
  }
  function operation(key: BrowserSourceKey, signal: AbortSignal): { controller: AbortController; cleanup: () => void } {
    if (disposed) throw new Error('browser_reader_disposed');
    checkSignal(signal);
    const controller = new AbortController();
    const id = keyOf(key), pending = sourceOperations.get(id) ?? new Set<AbortController>();
    pending.add(controller); sourceOperations.set(id, pending);
    const abort = () => controller.abort(signal.reason ?? abortError());
    signal.addEventListener('abort', abort, { once: true }); operations.add(controller);
    return { controller, cleanup: () => {
      signal.removeEventListener('abort', abort); operations.delete(controller); pending.delete(controller);
      if (sourceOperations.get(id) === pending && pending.size === 0) sourceOperations.delete(id);
    } };
  }
  async function open(input: BrowserSourceKey & { requestedUrl: string; beforeNavigate: () => Promise<void>; attemptId?: string | null }, signal: AbortSignal): Promise<SourceLease & { outcome: Awaited<ReturnType<BrowserService['open']>>['nav']['outcome'] }> {
    await interrupted(input.beforeNavigate(), signal); checkSignal(signal);
    const old = leases.get(keyOf(input));
    if (old?.unavailable && browser.researchOwnsTab(old.tabId, input.threadId)) browser.close(old.tabId);
    const previous = current(input);
    const canReuse = previous && browser.researchOwnsTab(previous.tabId, input.threadId)
      && previous.urls.has(canonical(browser.locationFacts(previous.tabId).currentUrl))
      && previous.requestedUrl === canonical(input.requestedUrl);
    if (previous && !canReuse && browser.researchOwnsTab(previous.tabId, input.threadId)) browser.keep(previous.tabId);
    const opening = browser.open({ url: input.requestedUrl, ...(canReuse ? { tabId: previous.tabId } : {}), ownerThreadId: input.threadId, activate: false, signal });
    // BrowserService aborts navigation, but still returns its synchronously created
    // tab. Clean a cancelled receipt if it never acquired a current association.
    const closeCancelledReceipt = (opened: { tabId: string }) => {
      if (signal.aborted && leases.get(keyOf(input))?.tabId !== opened.tabId && browser.researchOwnsTab(opened.tabId, input.threadId)) browser.close(opened.tabId);
    };
    void opening.then(closeCancelledReceipt, () => {});
    const opened = await interrupted(opening, signal);
    // Release can run after the receipt reaction but before this continuation.
    // Apply the same ownership/current-association guard before rejecting it.
    closeCancelledReceipt(opened);
    checkSignal(signal);
    const lease: SourceLease = { key: { threadId: input.threadId, researchRunId: input.researchRunId, sourceId: input.sourceId }, leaseId: randomUUID(), attemptId: input.attemptId ?? null, tabId: opened.tabId, requestedUrl: canonical(input.requestedUrl), urls: new Set(browser.researchNavigationUrls(opened.tabId, opened.nav.navigationId).map(canonical)) };
    lease.urls.add(lease.requestedUrl);
    leases.set(keyOf(input), lease);
    return { ...lease, outcome: opened.nav.outcome };
  }
  return {
    onLeaseUnavailable(listener) { lifecycle.add(listener); return () => { lifecycle.delete(listener); }; },
    currentTab(key) { return current(key)?.tabId; },
    async read(input) {
      const id = keyOf(input), op = operation(input, input.signal), controller = op.controller;
      attempts.get(id)?.abort(new Error('browser_attempt_superseded')); attempts.set(id, controller);
      let unlock: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
      let lease: SourceLease | undefined;
      let observedFacts: { finalUrl?: string; mainStatusCode?: number } = {};
      let ownerFailure: { error: unknown } | undefined;
      const owner = async <T>(work: () => Promise<T>): Promise<T> => {
        try { return await work(); } catch (error) { ownerFailure = { error }; throw error; }
      };
      const waiting = (reason: string, facts: { finalUrl?: string; mainStatusCode?: number } = observedFacts): BrowserReadResult => ({ status: 'waiting_user', reason, ...(lease ? { leaseId: lease.leaseId } : {}), ...facts });
      try {
        unlock = await acquire(controller.signal);
        checkSignal(controller.signal);
        timer = setTimeout(() => { timedOut = true; controller.abort(new Error('browser_read_timeout')); }, 30_000);
        lease = input.mode === 'capture_existing' ? current(input) : undefined;
        // A source retry may capture a new same-URL document. A foreign article is
        // retained for its user; creating a new dedicated tab is a new dispatch.
        if (lease && (!lease.urls.has(canonical(browser.locationFacts(lease.tabId).currentUrl)) || lease.requestedUrl !== canonical(input.requestedUrl))) lease = undefined;
        if (!lease) {
          const opened = await open({ ...input, beforeNavigate: () => owner(input.beforeNavigate) }, controller.signal); lease = leases.get(id)!;
          const outcome = opened.outcome;
          if (outcome.kind === 'ok' || outcome.kind === 'ok_same_document') observedFacts = { finalUrl: outcome.finalUrl, ...(outcome.kind === 'ok' ? { mainStatusCode: outcome.httpStatusCode } : {}) };
          if (outcome.kind !== 'ok' && outcome.kind !== 'ok_same_document') {
            return waiting(outcome.kind === 'timeout' ? 'browser_read_timeout' : outcome.kind === 'crashed' ? `renderer_crashed:${outcome.reason}` : `navigation_${outcome.kind}`);
          }
        }
        const activeLease = lease;
        activeLease.attemptId = input.attemptId;
        const navigated = (facts: { finalUrl?: string; mainStatusCode?: number } = {}) => {
          if (browser.researchOwnsTab(activeLease.tabId, input.threadId)) browser.keep(activeLease.tabId);
          return waiting('user_navigated', facts);
        };
        return await browser.withResearchDriving(activeLease.tabId, input.threadId, async () => {
          let observed: ResearchDocumentLease | undefined;
          let primaryFailure = false;
          try {
            while (true) {
              checkSignal(controller.signal);
              if (attempts.get(id) !== controller || leases.get(id) !== activeLease) return waiting('attempt_superseded');
              if (activeLease.unavailable) return waiting(activeLease.unavailable);
              if (browser.researchTabStatus(activeLease.tabId, input.threadId) !== 'available') return waiting('tab_unavailable');
              const location = browser.locationFacts(activeLease.tabId);
              if (!activeLease.urls.has(canonical(location.currentUrl))) return navigated({ finalUrl: location.currentUrl });
              if (location.navigationEvent === 'did-start-navigation' && location.navigationType === 'cross_document') {
                if (!location.navigationUrl || !activeLease.urls.has(canonical(location.navigationUrl))) return navigated({ finalUrl: location.navigationUrl ?? location.currentUrl });
                if (observed) await interrupted(observed.dispose(), controller.signal); observed = undefined;
                const reason = await interrupted(browser.waitForResearchNavigation(activeLease.tabId, location, controller.signal), controller.signal);
                if (reason) return waiting(reason);
                continue;
              }
              if (!observed) {
                try {
                  observed = await interrupted(browser.observeResearchDocument({ tabId: activeLease.tabId, ownerThreadId: input.threadId, signal: controller.signal }), controller.signal);
                } catch (error) {
                  // Only the observer's exact source fact can trigger rebinding.
                  // The next iteration rechecks lease, pending target and identity.
                  if (error instanceof ResearchDocumentInvalidatedError) continue;
                  throw error;
                }
              }
              const maxBytes = await interrupted(owner(input.remainingDomBytes), controller.signal);
              const capture = await interrupted(observed.capture(maxBytes), controller.signal);
              const facts = { finalUrl: location.currentUrl, ...(capture.mainStatusCode === undefined ? {} : { mainStatusCode: capture.mainStatusCode }) };
              observedFacts = facts;
              if (activeLease.unavailable) return waiting(activeLease.unavailable, facts);
              if (capture.status === 'invalidated') { await interrupted(observed.dispose(), controller.signal); observed = undefined; continue; }
              if (capture.status === 'oversize') return { status: 'budget_blocked', reason: 'browser_dom_budget', leaseId: activeLease.leaseId, ...facts };
              if (capture.status === 'snapshot') {
                const doc = capture.document;
                if (!sameDocument(browser, activeLease.tabId, doc)) return navigated(facts);
                const accepted = await interrupted(owner(() => input.onDocument(doc)), controller.signal);
                checkSignal(controller.signal);
                if (leases.get(id) !== activeLease || attempts.get(id) !== controller || activeLease.unavailable
                  || browser.researchTabStatus(activeLease.tabId, input.threadId) !== 'available'
                  || !sameDocument(browser, activeLease.tabId, doc)) return activeLease.unavailable ? waiting(activeLease.unavailable, facts) : navigated(facts);
                if (accepted === 'accepted') { const { html: _html, ...document } = doc; return { status: 'readable', document, leaseId: activeLease.leaseId }; }
              }
              if (capture.verificationWidget || capture.status === 'pending' && capture.reason === 'verification_widget') return waiting('verification_widget', facts);
              if (capture.mainStatusCode === 401 || capture.mainStatusCode === 403) return waiting(`http_${capture.mainStatusCode}`, facts);
              await interrupted(observed.waitForChange(capture.revision), controller.signal);
            }
          } catch (error) {
            primaryFailure = true;
            throw error;
          } finally {
            if (observed) {
              // Lease disposal unsubscribes immediately. CDP acknowledgements may
              // still be in flight; they cannot extend the automatic-read slot.
              // Convert synchronous disposal throws to a handled promise too.
              // A pending primary failure keeps its original identity.
              const cleanup = (async () => { await observed!.dispose(); })();
              if (controller.signal.aborted || primaryFailure) void cleanup.catch(() => {});
              else await interrupted(cleanup, controller.signal);
            }
          }
        });
      } catch (error) {
        if (ownerFailure && Object.is(error, ownerFailure.error)) throw error;
        if (timedOut) return waiting('browser_read_timeout');
        if (input.signal.aborted || disposed) throw input.signal.reason ?? error;
        if (controller.signal.aborted && attempts.get(id) !== controller) return waiting('attempt_superseded');
        const unavailable = lease?.unavailable ?? leases.get(id)?.unavailable;
        if (unavailable) return waiting(unavailable);
        throw error;
      } finally {
        if (timer) clearTimeout(timer); unlock?.(); op.cleanup();
        if (attempts.get(id) === controller) attempts.delete(id);
      }
    },
    async openForUser(input) {
      const op = operation(input, input.signal);
      try {
        const lease = current(input) ?? await open(input, op.controller.signal);
        checkSignal(op.controller.signal);
        if (current(input)?.leaseId !== lease.leaseId) throw new Error(lease.unavailable ?? 'browser_lease_unavailable');
        if (input.attemptId !== undefined) lease.attemptId = input.attemptId;
        browser.activate(lease.tabId);
        checkSignal(op.controller.signal);
        if (current(input)?.leaseId !== lease.leaseId) throw new Error(lease.unavailable ?? leases.get(keyOf(input))?.unavailable ?? 'browser_lease_unavailable');
        return { tabId: lease.tabId, leaseId: lease.leaseId };
      } finally { op.cleanup(); }
    },
    async release(key, options) {
      const id = keyOf(key), lease = leases.get(id);
      const pending = sourceOperations.get(id); sourceOperations.delete(id);
      for (const controller of pending ?? []) controller.abort(new Error('browser_lease_released'));
      attempts.delete(id); leases.delete(id);
      if (lease && options.closeOwned && browser.researchOwnsTab(lease.tabId, key.threadId)) browser.close(lease.tabId);
    },
    async dispose() {
      disposed = true; lifecycle.clear();
      for (const controller of operations) controller.abort(new Error('browser_reader_disposed'));
      for (const [id, lease] of leases) {
        const [threadId] = JSON.parse(id) as [string, string, string];
        if (browser.researchOwnsTab(lease.tabId, threadId)) browser.close(lease.tabId);
      }
      leases.clear(); lifecycle.clear(); offGone(); offUnavailable();
    },
  };
}
