import { KydogError } from '../../shared/errors';
import type { NavigationObservation } from '../../shared/types';
import type { BrowserService, BrowserLocationFacts, EvictedTab } from '../browser/browserService';
import type { DispatchAction, WaitUntil } from '../browser/actions';
import type { AxSnapshot } from '../browser/snapshot';

/** All values remain inside trusted main-process adapters. Redact at serialization. */
export interface XOpenResult { tabId: string; nav: NavigationObservation; evicted: EvictedTab[] }
export interface XActionResult { action: DispatchAction; line: string; navigation: NavigationObservation | null }
export interface XQueuedPage {
  snapshot(): Promise<AxSnapshot>;
  /** Fixed program-owned extractor only; Task3 supplies the DOM adapter. */
  collect(): Promise<unknown>;
  act(action: DispatchAction, snapshot: AxSnapshot): Promise<XActionResult>;
  wait(until: WaitUntil, timeoutMs: number): Promise<boolean>;
  location(): BrowserLocationFacts;
}
export interface XResearchBrowser {
  open(url: string, tabId: string | undefined, signal?: AbortSignal): Promise<XOpenResult>;
  withPage<T>(tabId: string, signal: AbortSignal | undefined, work: (page: XQueuedPage) => Promise<T>): Promise<T>;
}

export function createXResearchBrowser(browser: BrowserService, threadId: string): XResearchBrowser {
  return {
    // BrowserService.open owns its one queue entry. Never enqueue around it.
    open: (url, tabId, signal) => browser.open({ url, tabId, ownerThreadId: threadId, activate: false, signal }),
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
      const run = async <T>(fn: () => Promise<T>): Promise<T> => {
        check();
        const operation = fn(); issued.add(operation);
        void operation.then(() => issued.delete(operation), () => issued.delete(operation));
        const value = await Promise.race([operation, stopped]); check(); return value;
      };
      const bindings = new Map<AxSnapshot, BrowserLocationFacts>();
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
        collect: () => run(async () => { throw new KydogError('x.collect_unavailable', '固定 X 页面抽取器尚未接入'); }),
        act: (action, snapshot) => run(async () => {
          const expected = bindings.get(snapshot), current = browser.locationFacts(tabId);
          if (!expected || expected.documentEpoch !== current.documentEpoch || expected.routeRevision !== current.routeRevision || expected.navigationSequence !== current.navigationSequence || expected.currentUrl !== current.currentUrl)
            throw new KydogError('browser.stale_snapshot', '动作必须绑定本次操作内的当前快照');
          const result = await browser.dispatchAndObserveNavigation(tabId, action, snapshot, { signal: lifetime.signal, location: expected, strictSnapshot: true });
          return { action: { ...action }, ...result };
        }),
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
        signal?.removeEventListener('abort', abort); offGone(); offUnavailable();
        lifetime.abort(); bindings.clear();
      }
    },
  };
}
