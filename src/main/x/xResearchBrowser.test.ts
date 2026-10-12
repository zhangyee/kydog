import { describe, expect, it } from 'vitest';
import type { BrowserService, BrowserLocationFacts } from '../browser/browserService';
import type { AxSnapshot } from '../browser/snapshot';
import { createXResearchBrowser } from './xResearchBrowser';

function fixture() {
  let tail = Promise.resolve();
  let queues = 0, injections = 0;
  const facts: BrowserLocationFacts = { currentUrl: 'https://x.com/a/status/123', documentEpoch: 1, routeRevision: 0, navigationEvent: 'did-navigate', navigationSequence: 1, navigationType: 'cross_document', navigationUrl: 'https://x.com/a/status/123' };
  const snapshot = { snapshotId: 'snap', generation: 'doc', url: facts.currentUrl, nodes: [] } as unknown as AxSnapshot;
  const gone = new Set<(id: string) => void>();
  const unavailable = new Set<(id: string) => void>();
  const enqueue = <T>(_id: string, work: () => Promise<T>) => { queues++; const next = tail.then(work, work); tail = next.then(() => {}, () => {}); return next; };
  const browser = {
    enqueue,
    open: (args: { url: string; tabId?: string }) => enqueue(args.tabId ?? 'tab', async () => ({ tabId: 'tab', nav: { navigationId: 'nav', outcome: { kind: 'ok', finalUrl: args.url, httpStatusCode: 200 } }, evicted: [] })),
    withAgentDriving: <T>(_id: string, _thread: string, work: () => Promise<T>) => work(),
    locationFacts: () => ({ ...facts }),
    snapshot: async () => { injections++; return snapshot; },
    dispatchAndObserveNavigation: async () => { injections++; return { line: 'acted', navigation: null }; },
    waitFor: async () => { injections++; return true; },
    onTabDestroyed: (fn: (id: string) => void) => { gone.add(fn); return () => gone.delete(fn); },
    onTabUnavailable: (fn: (id: string) => void) => { unavailable.add(fn); return () => unavailable.delete(fn); },
  } as unknown as BrowserService;
  return { browser, facts, snapshot, enqueue, gone, unavailable, count: () => ({ queues, injections }) };
}

describe('X queued browser port', () => {
  it('oneQueuePerOperation: open, queued cancellation, action exception and next task', async () => {
    const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
    await port.open(f.facts.currentUrl, undefined);
    expect(f.count()).toEqual({ queues: 1, injections: 0 });
    await port.withPage('tab', undefined, async page => { const snap = await page.snapshot(); await page.act({ kind: 'click', index: 1, snapshotId: snap.snapshotId }, snap); await page.wait({ urlMatches: '/status/123' }, 100); });
    expect(f.count()).toEqual({ queues: 2, injections: 3 });
    let release!: () => void;
    const blocker = f.enqueue('tab', () => new Promise<void>(r => { release = r; }));
    await Promise.resolve();
    const abort = new AbortController();
    const pending = port.withPage('tab', abort.signal, async page => page.snapshot());
    const rejected = expect(pending).rejects.toMatchObject({ code: 'browser.cancelled' });
    abort.abort(); release(); await blocker; await rejected;
    expect(f.count().injections).toBe(3);
    await expect(port.withPage('tab', undefined, async () => { throw new Error('action failed'); })).rejects.toThrow('action failed');
    await port.withPage('tab', undefined, async page => page.snapshot());
    expect(f.count()).toEqual({ queues: 6, injections: 4 });
  });
  it('a normalization remains visible but every route or document event invalidates the old binding', async () => {
    const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
    await port.withPage('tab', undefined, async page => {
      const snap = await page.snapshot();
      await page.act({ kind: 'click', selector: '#safe' }, snap);
      f.facts.currentUrl = 'https://x.com/i/web/status/123'; f.facts.routeRevision++;
      expect(page.location()).toMatchObject({ currentUrl: f.facts.currentUrl, documentEpoch: 1, routeRevision: 1 });
      await expect(page.act({ kind: 'click', selector: '#safe' }, snap)).rejects.toMatchObject({ code: 'browser.stale_snapshot' });
      const fresh = await page.snapshot();
      f.facts.documentEpoch++;
      await expect(page.act({ kind: 'click', selector: '#safe' }, fresh)).rejects.toMatchObject({ code: 'browser.stale_snapshot' });
    });
    expect(f.count().injections).toBe(3);
  });
  it('tab destruction and crash terminate an in-flight wait and remove only owned listeners', async () => {
    for (const event of ['gone', 'unavailable'] as const) {
      const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
      const external = () => {}; f[event].add(external);
      let start!: () => void; const started = new Promise<void>(r => { start = r; });
      const running = port.withPage('tab', undefined, async () => { start(); return new Promise(() => {}); });
      const rejected = expect(running).rejects.toMatchObject({ code: 'browser.not_dispatchable' });
      await started;
      expect(f[event].size).toBe(2);
      for (const notify of [...f[event]]) notify('tab');
      await rejected;
      expect([...f[event]]).toEqual([external]);
    }
  });
  it('collect has a fixed unavailable operation and no caller evaluator', async () => {
    const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
    await port.withPage('tab', undefined, async page => {
      expect(Object.keys(page).sort()).toEqual(['act', 'collect', 'location', 'snapshot', 'wait']);
      await expect(page.collect()).rejects.toMatchObject({ code: 'x.collect_unavailable' });
    });
  });
});


it.each(['cancel', 'destroy', 'crash'] as const)('queued %s rejects before the preceding queue task releases', async reason => {
  const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
  await port.withPage('tab', undefined, page => page.snapshot());
  expect(f.count().injections).toBe(1);
  let release!: () => void;
  const blocker = f.enqueue('tab', () => new Promise<void>(r => { release = r; }));
  await Promise.resolve();
  const abort = new AbortController();
  const pending = port.withPage('tab', abort.signal, page => page.snapshot());
  const rejected = expect(pending).rejects.toMatchObject({ code: reason === 'cancel' ? 'browser.cancelled' : 'browser.not_dispatchable' });
  if (reason === 'cancel') abort.abort();
  else for (const notify of [...f[reason === 'destroy' ? 'gone' : 'unavailable']]) notify('tab');
  // If lifetime wiring starts only after dequeue, this await deadlocks and REDs.
  await rejected;
  expect(f.count().injections).toBe(1);
  release(); await blocker;
  await f.enqueue('tab', async () => {});
  expect(f.count().injections).toBe(1);
});


it('caller cancellation is prompt but the queue lease covers deferred native release and cleanup', async () => {
  const f = fixture(), port = createXResearchBrowser(f.browser, 'thread');
  const order: string[] = [];
  await port.withPage('tab', undefined, async () => { order.push('control entered'); });
  expect(order).toEqual(['control entered']); order.length = 0;
  let pressed!: () => void, releasePress!: () => void, cleanupStarted!: () => void, releaseCleanup!: () => void;
  const started = new Promise<void>(r => { pressed = r; });
  const cleaned = new Promise<void>(r => { cleanupStarted = r; });
  f.browser.dispatchAndObserveNavigation = async () => {
    order.push('press in flight'); pressed();
    await new Promise<void>(r => { releasePress = r; });
    order.push('native release'); cleanupStarted();
    await new Promise<void>(r => { releaseCleanup = r; });
    order.push('cleanup settled');
    return { line: 'clicked', navigation: null };
  };
  const abort = new AbortController();
  const old = port.withPage('tab', abort.signal, async page => { const snap = await page.snapshot(); return page.act({ kind: 'click', selector: '#target' }, snap); });
  const rejected = expect(old).rejects.toMatchObject({ code: 'browser.cancelled' });
  await started; abort.abort(); await rejected; order.push('caller cancelled');
  const next = port.withPage('tab', undefined, async () => { order.push('next entered'); });
  // Drain runnable promise continuations, never advance a deadline or infer from elapsed time.
  for (let i = 0; i < 24; i++) await Promise.resolve();
  expect(order).toEqual(['press in flight', 'caller cancelled']);
  releasePress(); await cleaned;
  for (let i = 0; i < 24; i++) await Promise.resolve();
  expect(order).toEqual(['press in flight', 'caller cancelled', 'native release']);
  releaseCleanup(); await next;
  expect(order).toEqual(['press in flight', 'caller cancelled', 'native release', 'cleanup settled', 'next entered']);
});
