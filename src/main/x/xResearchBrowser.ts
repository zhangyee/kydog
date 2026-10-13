import { KydogError } from '../../shared/errors';
import type { NavigationObservation } from '../../shared/types';
import type { BrowserService, BrowserLocationFacts, EvictedTab } from '../browser/browserService';
import type { DispatchAction, WaitUntil } from '../browser/actions';
import type { AxSnapshot } from '../browser/snapshot';
import { decodeXPage, xPageExpression, type XPageRequest, type XPageObservation } from './xPageSource';
import type { XArticleEntry } from './xResearchTypes';

/** All values remain inside trusted main-process adapters. Redact at serialization. */
export interface XOpenResult { tabId: string; nav: NavigationObservation; evicted: EvictedTab[] }
export interface XActionResult { action: DispatchAction; line: string; navigation: NavigationObservation | null }
export interface XActionOptions { scrollAcknowledgement?: { onWritten: () => void } }
export interface XQueuedPage {
  snapshot(): Promise<AxSnapshot>;
  /** Fixed program-owned extractor with validated DOM observations. */
  collect(request: XPageRequest): Promise<XPageObservation>;
  act(action: DispatchAction, snapshot: AxSnapshot, options?: XActionOptions): Promise<XActionResult>;
  wait(until: WaitUntil, timeoutMs: number): Promise<boolean>;
  location(): BrowserLocationFacts;
}
export interface XResearchBrowser {
  tabStatus?(tabId: string): 'available' | 'foreign' | 'missing';
  open(url: string, tabId: string | undefined, signal?: AbortSignal): Promise<XOpenResult>;
  withPage<T>(tabId: string, signal: AbortSignal | undefined, work: (page: XQueuedPage) => Promise<T>): Promise<T>;
}

export function createXResearchBrowser(browser: BrowserService, threadId: string): XResearchBrowser {
  const sameLocation = (a: BrowserLocationFacts, b: BrowserLocationFacts) => a.documentEpoch===b.documentEpoch && a.routeRevision===b.routeRevision && a.navigationSequence===b.navigationSequence && a.currentUrl===b.currentUrl;
  const entries = new WeakMap<XArticleEntry, {tabId:string; snapshot:AxSnapshot}>();
  const actions = new WeakMap<XActionResult, {tabId:string; entry:XArticleEntry; location:BrowserLocationFacts; finalUrl:string|null}>();
  const opens = new WeakMap<XOpenResult, {tabId:string; requestedUrl:string; location:BrowserLocationFacts; finalUrl:string|null}>();
  const finalUrl = (nav: NavigationObservation|null) => nav && (nav.outcome.kind==='ok' || nav.outcome.kind==='ok_same_document') ? nav.outcome.finalUrl : null;
  return {
    tabStatus: tabId => browser.researchTabStatus(tabId, threadId),
    // BrowserService.open owns its one queue entry. Never enqueue around it.
    open: async (url, tabId, signal) => {
      if(tabId && browser.researchTabStatus(tabId, threadId)==='foreign')
        throw new KydogError('browser.bad_action','X research tab belongs to another thread');
      const result = await browser.open({ url, tabId, ownerThreadId: threadId, activate: false, signal });
      const destination = finalUrl(result.nav);
      if (destination) {
        try {
          opens.set(result,{tabId:result.tabId,requestedUrl:url,location:browser.locationFacts(result.tabId),finalUrl:destination});
        } catch (error) {
          // Losing an optional Article proof must not erase a real navigation outcome.
          if (!(error instanceof KydogError) || error.code!=='browser.no_tab') throw error;
        }
      }
      return result;
    },
    withPage: async (tabId, signal, work) => {
      const lifetime = new AbortController();
      let failure: KydogError | undefined;
      let rejectStopped!: (error: KydogError) => void;
      const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
      const stop = (error: KydogError) => {
        if (failure) return;
        failure = error; lifetime.abort(); rejectStopped(error);
      };
      const abort = () => stop(new KydogError('browser.cancelled', '浏览器操作已取消'));
      const gone = (id: string) => { if (id === tabId) stop(new KydogError('browser.not_dispatchable', '目标标签已销毁或渲染进程已退出')); };
      const offGone = browser.onTabDestroyed(gone), offUnavailable = browser.onTabUnavailable(gone);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const check = () => { if (failure) throw failure; if (lifetime.signal.aborted) throw new KydogError('browser.cancelled', '这次浏览器操作已结束'); };
      const issued = new Set<Promise<unknown>>();
      const pendingScrolls = new Set<Promise<unknown>>();
      const run = async <T>(fn: () => Promise<T>, drainScroll = false): Promise<T> => {
        check();
        const operation = fn(); issued.add(operation);
        if (drainScroll) { pendingScrolls.add(operation); void operation.then(()=>pendingScrolls.delete(operation),()=>pendingScrolls.delete(operation)); }
        void operation.then(() => issued.delete(operation), () => issued.delete(operation));
        const value = await Promise.race([operation, stopped]); check(); return value;
      };
      const bindings = new Map<AxSnapshot, BrowserLocationFacts>();
      const permissions = new Map<AxSnapshot, Map<number, {owner:string;token:string;purpose:string}>>();
      const currentEntries = new Map<AxSnapshot, XArticleEntry[]>();
      const page: XQueuedPage = {
        snapshot: () => run(async () => {
          const before = browser.locationFacts(tabId);
          const snapshot = await browser.snapshot(tabId, lifetime.signal);
          check();
          const after = browser.locationFacts(tabId);
          if (before.documentEpoch !== after.documentEpoch || before.routeRevision !== after.routeRevision || before.navigationSequence !== after.navigationSequence || before.currentUrl !== after.currentUrl)
            throw new KydogError('browser.stale_snapshot', '采集期间页面已导航；需要新快照');
          bindings.set(snapshot, after); return snapshot;
        }),
        collect: request => run(async () => {
          const expression = xPageExpression(request);
          const before = browser.locationFacts(tabId);
          await browser.prepareForDomRead(tabId,lifetime.signal); check();
          const raw = await browser.evalInPage(tabId,expression); check();
          const after = browser.locationFacts(tabId);
          if (!sameLocation(before,after)) throw new KydogError('browser.stale_snapshot','采集期间页面已导航；需要新观察');
          let articleProven = false;
          if (request.stage==='article') {
            const issuedEntry=entries.get(request.entry);
            const proof=request.via.kind==='action' ? actions.get(request.via.result) : opens.get(request.via.result);
            articleProven=!!issuedEntry && issuedEntry.tabId===tabId && !!proof && proof.tabId===tabId
              && sameLocation(proof.location,after) && proof.finalUrl===request.expectedUrl
              && ('entry' in proof ? proof.entry===request.entry : request.entry.targetUrl!==null && proof.requestedUrl===request.entry.targetUrl);
          }
          if (request.stage==='post' && request.directOpen) {
            const proof=opens.get(request.directOpen);
            articleProven=!!proof && proof.tabId===tabId && sameLocation(proof.location,after)
              && proof.requestedUrl===request.expectedUrl && proof.finalUrl===request.expectedUrl
              && after.currentUrl===request.expectedUrl;
          }
          const observation=decodeXPage(raw,request,after,articleProven);
          bindings.set(observation.snapshot,after);
          permissions.set(observation.snapshot,new Map(observation.snapshot.nodes.flatMap(n=>n.collectedPermission?[[n.index,{...n.collectedPermission}]]:[])));
          currentEntries.set(observation.snapshot,[...observation.entries]);
          for (const entry of observation.entries) {
            Object.freeze(entry.binding); Object.freeze(entry);
            entries.set(entry,{tabId,snapshot:observation.snapshot});
          }
          return observation;
        }),
        act: (action, snapshot, options) => run(async () => {
          if (options?.scrollAcknowledgement && action.kind!=='scroll') throw new KydogError('browser.bad_action','滚动确认只适用于滚动动作');
          const expected = bindings.get(snapshot), current = browser.locationFacts(tabId);
          if (!expected || expected.documentEpoch !== current.documentEpoch || expected.routeRevision !== current.routeRevision || expected.navigationSequence !== current.navigationSequence || expected.currentUrl !== current.currentUrl)
            throw new KydogError('browser.stale_snapshot', '动作必须绑定本次操作内的当前快照');
          let collectedPermission;
          if (permissions.has(snapshot) && action.kind==='click') {
            collectedPermission='index' in action && action.snapshotId===snapshot.snapshotId ? permissions.get(snapshot)?.get(action.index) : undefined;
            if (!collectedPermission) throw new KydogError('browser.bad_action','X 控件必须使用原采集节点和许可');
          }
          const result = await browser.dispatchAndObserveNavigation(tabId, action, snapshot, { signal: lifetime.signal, location: expected, strictSnapshot: true, ...(collectedPermission?{collectedPermission,collectedPointerEligibility:true}:{}), ...(options?.scrollAcknowledgement?{scrollAcknowledgement:options.scrollAcknowledgement}:{}) });
          const output = { action: { ...action }, ...result };
          const entry = action.kind==='click' && 'index' in action && action.snapshotId===snapshot.snapshotId
            ? currentEntries.get(snapshot)?.find(e=>e.binding.index===action.index) : undefined;
          if (entry) actions.set(output,{tabId,entry,location:browser.locationFacts(tabId),finalUrl:finalUrl(result.navigation)});
          return output;
        }, !!options?.scrollAcknowledgement),
        wait: (until, timeoutMs) => run(() => browser.waitFor(tabId, until, timeoutMs, lifetime.signal)),
        location: () => { check(); return browser.locationFacts(tabId); },
      };
      try {
        const queued = browser.enqueue(tabId, async () => {
          check(); browser.locationFacts(tabId);
          return browser.withAgentDriving(tabId, threadId, async () => {
            try { return await Promise.race([Promise.resolve().then(() => work(page)), stopped]); }
            finally {
              // Caller cancellation can win immediately; actual queue/driving
              // ownership lasts until issued native releases and cleanup settle.
              while (issued.size) await Promise.allSettled([...issued]);
            }
          }, 'X 研究');
        });
        return await Promise.race([queued, stopped]);
      }
      finally {
        lifetime.abort();
        while (pendingScrolls.size) await Promise.allSettled([...pendingScrolls]);
        signal?.removeEventListener('abort', abort); offGone(); offUnavailable();
        lifetime.abort(); bindings.clear(); currentEntries.clear(); permissions.clear();
      }
    },
  };
}
