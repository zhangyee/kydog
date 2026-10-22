import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserService } from '../browser/browserService';
import { ResearchDocumentInvalidatedError, type ResearchDocumentCapture } from '../browser/researchDocument';
import type { BrowserReadInput, ResearchDocumentSnapshot } from './browserReadTypes';
import { createBrowserReader } from './browserReader';

const url = 'https://article.example/a';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  type Tab = { url: string; epoch: number; route: number; sequence: number; owner: string | null; status: number; navigationEvent?: 'did-start-navigation' | 'did-navigate'; navigationType?: 'cross_document'; navigationUrl?: string; capture?: (maxBytes: number) => Promise<ResearchDocumentCapture> };
  const tabs = new Map<string, Tab>();
  const destroyed = new Set<(id: string, reason: string) => void>();
  const unavailable = new Set<(id: string, reason: string) => void>();
  const wake = new Set<() => void>();
  let count = 0, driving = 0, maximum = 0;
  const snapshot = (id: string): ResearchDocumentSnapshot => {
    const t = tabs.get(id)!;
    return { url: t.url, identity: { documentEpoch: t.epoch, routeRevision: t.route, navigationSequence: t.sequence }, rootRule: 'article', utf8Bytes: 38, html: '<article>Evidence</article>', mainStatusCode: t.status };
  };
  const browser = {
    open: vi.fn(async (args: {url: string; tabId?: string; ownerThreadId: string; activate: boolean}) => {
      const tabId = args.tabId ?? `tab-${++count}`;
      tabs.set(tabId, { url: args.url, epoch: 1, route: 0, sequence: 2, owner: args.ownerThreadId, status: 200 });
      return { tabId, nav: { navigationId: `nav-${count}`, outcome: { kind: 'ok', finalUrl: args.url, httpStatusCode: 200 } }, evicted: [] };
    }),
    researchNavigationUrls: (_id: string, _nav: string) => [url],
    researchTabStatus: (id: string, owner: string) => !tabs.has(id) ? 'missing' : tabs.get(id)!.owner === null || tabs.get(id)!.owner === owner ? 'available' : 'foreign',
    researchOwnsTab: (id: string, owner: string) => tabs.get(id)?.owner === owner,
    locationFacts: (id: string) => { const doc = snapshot(id); return { currentUrl: doc.url, ...doc.identity, navigationEvent: tabs.get(id)!.navigationEvent, navigationType: tabs.get(id)!.navigationType, navigationUrl: tabs.get(id)!.navigationUrl }; },
    withResearchDriving: async <T>(id: string, _owner: string, work: () => Promise<T>) => { expect(tabs.has(id)).toBe(true); driving++; maximum = Math.max(maximum, driving); try { return await work(); } finally { driving--; } },
    observeResearchDocument: vi.fn(async ({ tabId, signal }: {tabId: string; signal: AbortSignal}) => ({
      capture: async (maxBytes: number) => tabs.get(tabId)?.capture?.(maxBytes) ?? { status: 'snapshot', revision: 0, document: snapshot(tabId) },
      waitForChange: () => new Promise<void>(resolve => { wake.add(resolve); signal.addEventListener('abort', () => resolve(), { once: true }); }),
      dispose: async () => {},
    })),
    onTabDestroyed: (fn: (id: string, reason: string) => void) => { destroyed.add(fn); return () => { destroyed.delete(fn); }; },
    onTabUnavailable: (fn: (id: string, reason: string) => void) => { unavailable.add(fn); return () => { unavailable.delete(fn); }; },
    keep: vi.fn((id: string) => { tabs.get(id)!.owner = null; }),
    waitForResearchNavigation: vi.fn(async (_id: string, _before: unknown, signal: AbortSignal) => new Promise<undefined>(resolve => { wake.add(() => resolve(undefined)); signal.addEventListener('abort', () => resolve(undefined), { once: true }); })),
    activate: vi.fn(), close: vi.fn((id: string) => { tabs.delete(id); for (const fn of destroyed) fn(id, 'tab_closed'); }),
  };
  const reader = createBrowserReader({ browser: browser as unknown as BrowserService });
  const input = (overrides: Partial<BrowserReadInput> = {}): BrowserReadInput => ({ threadId: 'thread-a', researchRunId: 'run-a', sourceId: 'source-a', attemptId: 'attempt-a', requestedUrl: url, mode: 'navigate', signal: new AbortController().signal, beforeNavigate: vi.fn(async () => {}), remainingDomBytes: async () => 1000, onDocument: vi.fn(async () => 'accepted' as const), ...overrides });
  return { browser, reader, input, tabs, snapshot, destroyed, unavailable, wake, stats: () => ({ driving, maximum }) };
}
afterEach(() => { vi.useRealTimers(); });
describe('source browser reader', () => {
  it('captures a verified page without refreshing it and only reserves new user opens', async () => {
    const f = fixture(), input = f.input();
    expect((await f.reader.read(input)).status).toBe('readable');
    expect(input.beforeNavigate).toHaveBeenCalledTimes(1);
    expect(f.browser.open).toHaveBeenCalledWith(expect.objectContaining({ activate: false, ownerThreadId: 'thread-a' }));
    expect((await f.reader.read({ ...input, attemptId: 'retry', mode: 'capture_existing' })).status).toBe('readable');
    expect(input.beforeNavigate).toHaveBeenCalledTimes(1);
    expect(input.onDocument).toHaveBeenCalledTimes(2);
    expect(await f.reader.openForUser(input)).toMatchObject({ tabId: 'tab-1' });
    expect(f.browser.activate).toHaveBeenCalledWith('tab-1');
    expect(input.beforeNavigate).toHaveBeenCalledTimes(1);
    await f.reader.release(input, { closeOwned: true });
    expect(f.browser.close).toHaveBeenCalledWith('tab-1');
    expect(await f.reader.openForUser(input)).toMatchObject({ tabId: 'tab-2' });
    expect(input.beforeNavigate).toHaveBeenCalledTimes(2);
    await f.reader.dispose();
  });
  it('serializes readers across tasks but releases the slot while waiting for a user', async () => {
    const f = fixture(), gate = deferred<'accepted'>();
    const first = f.reader.read(f.input({ onDocument: () => gate.promise }));
    await flush();
    const other = createBrowserReader({ browser: f.browser as unknown as BrowserService });
    const second = other.read(f.input({ threadId: 'thread-b', researchRunId: 'run-b' }));
    await flush();
    expect(f.stats()).toEqual({ driving: 1, maximum: 1 });
    expect(f.browser.open).toHaveBeenCalledTimes(1);
    gate.resolve('accepted');
    expect((await first).status).toBe('readable');
    expect((await second).status).toBe('readable');
    f.tabs.get('tab-1')!.capture = async () => ({ status: 'pending', revision: 0, reason: 'verification_widget' });
    expect(await f.reader.read(f.input({ mode: 'capture_existing', attemptId: 'retry' }))).toMatchObject({ status: 'waiting_user', reason: 'verification_widget', finalUrl: url });
    expect(f.stats()).toEqual({ driving: 0, maximum: 1 });
    expect((await other.read(f.input({ threadId: 'thread-b', researchRunId: 'run-b', mode: 'capture_existing' }))).status).toBe('readable');
    await f.reader.dispose(); await other.dispose();
  });
  it.each(['epoch', 'route', 'sequence', 'url'] as const)('rejects a %s change during async parsing but accepts a fresh same-URL retry', async field => {
    const f = fixture(), base = f.input();
    expect((await f.reader.read(base)).status).toBe('readable');
    const gate = deferred<'accepted'>();
    const reading = f.reader.read({ ...base, mode: 'capture_existing', attemptId: 'retry', onDocument: () => gate.promise });
    await flush();
    const tab = f.tabs.get('tab-1')!;
    if (field === 'url') tab.url = 'https://article.example/other'; else tab[field]++;
    gate.resolve('accepted');
    expect(await reading).toMatchObject({ status: 'waiting_user', reason: 'user_navigated', finalUrl: url });
    tab.url = url;
    expect((await f.reader.read({ ...base, mode: 'capture_existing', attemptId: 'fresh' })).status).toBe('readable');
    await f.reader.dispose();
  });
  it('keeps source/thread leases separate and preserves a kept user page on release', async () => {
    const f = fixture(), a = f.input();
    expect((await f.reader.read(a)).status).toBe('readable');
    expect(f.reader.currentTab(a)).toBe('tab-1');
    expect(f.reader.currentTab({ ...a, sourceId: 'other' })).toBeUndefined();
    expect(f.reader.currentTab({ ...a, threadId: 'other' })).toBeUndefined();
    f.tabs.get('tab-1')!.owner = null;
    await f.reader.release(a, { closeOwned: true });
    expect(f.tabs.has('tab-1')).toBe(true);
    await f.reader.openForUser(a);
    expect(f.reader.currentTab(a)).toBe('tab-2');
    expect(f.tabs.has('tab-2')).toBe(true);
    await f.reader.release(a, { closeOwned: true });
    expect(f.tabs.has('tab-2')).toBe(false);
    await f.reader.dispose();
  });
  it('returns only timeout for pending roots and preserves owner callback errors', async () => {
    vi.useFakeTimers();
    const f = fixture(), a = f.input();
    expect((await f.reader.read(a)).status).toBe('readable');
    f.tabs.get('tab-1')!.capture = async () => ({ status: 'pending', revision: 0, reason: 'article_root_missing' });
    const reading = f.reader.read({ ...a, mode: 'capture_existing', attemptId: 'retry' });
    await flush(); await vi.advanceTimersByTimeAsync(30_000);
    expect(await reading).toMatchObject({ status: 'waiting_user', reason: 'browser_read_timeout' });
    const error = new Error('durable save failed');
    await expect(f.reader.read(f.input({ sourceId: 'new', beforeNavigate: async () => { throw error; } }))).rejects.toBe(error);
    f.tabs.get('tab-1')!.capture = async () => ({ status: 'snapshot', revision: 1, document: f.snapshot('tab-1') });
    await expect(f.reader.read({ ...a, mode: 'capture_existing', onDocument: async () => { throw error; } })).rejects.toBe(error);
    await f.reader.dispose();
  });
  it('waits for a same-URL reload commit, but refuses a departing article with a foreign pending target', async () => {
    const f = fixture(), callback = vi.fn(async () => 'accepted' as const), a = f.input({ onDocument: callback });
    expect((await f.reader.read(a)).status).toBe('readable');
    expect(callback).toHaveBeenCalledTimes(1);
    const tab = f.tabs.get('tab-1')!;
    tab.navigationEvent = 'did-start-navigation'; tab.navigationType = 'cross_document'; tab.navigationUrl = url; tab.sequence++;
    const retry = f.reader.read({ ...a, mode: 'capture_existing', attemptId: 'reload', onDocument: callback });
    await flush();
    expect(f.browser.waitForResearchNavigation).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    tab.epoch++; tab.sequence++; tab.navigationEvent = 'did-navigate';
    for (const wake of f.wake) wake(); f.wake.clear();
    expect((await retry)).toMatchObject({ status: 'readable', document: { identity: { documentEpoch: 2 } } });
    expect(callback).toHaveBeenCalledTimes(2);
    tab.navigationEvent = 'did-start-navigation'; tab.navigationUrl = 'https://article.example/other'; tab.sequence++;
    expect(await f.reader.read({ ...a, mode: 'capture_existing', attemptId: 'foreign', onDocument: callback })).toMatchObject({ status: 'waiting_user', reason: 'user_navigated' });
    expect(callback).toHaveBeenCalledTimes(2);
    await f.reader.dispose();
  });
  it.each(['tab_closed', 'tab_evicted', 'renderer_crashed:oom'])('wakes a pending read with the real lifecycle reason %s', async reason => {
    const f = fixture(), a = f.input();
    expect((await f.reader.read(a)).status).toBe('readable');
    f.tabs.get('tab-1')!.capture = async () => ({ status: 'pending', reason: 'article_root_missing', revision: 0 });
    const reading = f.reader.read({ ...a, mode: 'capture_existing', attemptId: 'waiting' });
    await flush();
    expect(f.stats().driving).toBe(1);
    if (reason.startsWith('renderer')) { for (const fn of f.unavailable) fn('tab-1', 'oom'); }
    else { f.tabs.delete('tab-1'); for (const fn of f.destroyed) fn('tab-1', reason); }
    expect(await reading).toMatchObject({ status: 'waiting_user', reason });
    expect(f.stats().driving).toBe(0);
    await f.reader.dispose();
  });
  it('cancels a queued reader without waiting for another task and rejects late old attempts', async () => {
    const f = fixture(), gate = deferred<'accepted'>(), callback = vi.fn(() => gate.promise);
    const first = f.reader.read(f.input({ onDocument: callback }));
    await flush(); expect(callback).toHaveBeenCalledTimes(1);
    const cancel = new AbortController(), cancelled = new Error('owner cancelled');
    const other = f.reader.read(f.input({ sourceId: 'source-b', signal: cancel.signal }));
    const rejection = expect(other).rejects.toBe(cancelled);
    cancel.abort(cancelled); await rejection;
    expect(f.browser.open).toHaveBeenCalledTimes(1);
    const replacement = f.reader.read(f.input({ mode: 'capture_existing', attemptId: 'replacement' }));
    expect(await first).toMatchObject({ status: 'waiting_user', reason: 'attempt_superseded' });
    expect((await replacement).status).toBe('readable');
    gate.resolve('accepted'); await flush();
    expect(f.reader.currentTab(f.input())).toBe('tab-1');
    expect(f.stats()).toEqual({ driving: 0, maximum: 1 });
    await f.reader.dispose();
  });
  it.each([401, 403])('retains real HTTP %s with pending roots and still accepts supported content', async status => {
    const f = fixture(), a = f.input();
    expect((await f.reader.read(a)).status).toBe('readable');
    f.tabs.get('tab-1')!.status = status;
    f.tabs.get('tab-1')!.capture = async () => ({ status: 'pending', reason: 'article_root_missing', revision: 0, mainStatusCode: status });
    expect(await f.reader.read({ ...a, mode: 'capture_existing' })).toMatchObject({ status: 'waiting_user', reason: `http_${status}`, mainStatusCode: status, finalUrl: url });
    f.tabs.get('tab-1')!.capture = async () => ({ status: 'snapshot', revision: 1, mainStatusCode: status, verificationWidget: true, document: f.snapshot('tab-1') });
    expect(await f.reader.read({ ...a, mode: 'capture_existing' })).toMatchObject({status:'readable',document:{mainStatusCode:status}});
    expect(await f.reader.read({ ...a, mode: 'capture_existing', onDocument: async () => 'continue' })).toMatchObject({ status: 'waiting_user', reason: 'verification_widget', mainStatusCode: status, finalUrl: url });
    await f.reader.dispose();
  });
  it('retains an abandoned kept page for its user and reserves a fresh source tab', async () => {
    const f = fixture(), a = f.input();
    expect((await f.reader.read(a)).status).toBe('readable');
    f.tabs.get('tab-1')!.owner = null; f.tabs.get('tab-1')!.url = 'https://article.example/other';
    expect((await f.reader.read({ ...a, mode: 'capture_existing', attemptId: 'fresh' })).status).toBe('readable');
    expect(a.beforeNavigate).toHaveBeenCalledTimes(2);
    expect(f.reader.currentTab(a)).toBe('tab-2');
    expect(f.tabs.has('tab-2')).toBe(true);
    await f.reader.release(a, { closeOwned: true });
    expect(f.tabs.has('tab-1')).toBe(true);
    expect(f.tabs.has('tab-2')).toBe(false);
    await f.reader.dispose();
  });

});

it('permits only observed redirects and preserves foreign user navigation on cancellation cleanup', async () => {
  const f = fixture(), a = f.input(), finalUrl = 'https://article.example/redirected';
  f.browser.researchNavigationUrls = () => [url, finalUrl];
  const initialOpen = f.browser.open.getMockImplementation()!;
  f.browser.open.mockImplementation(async args => {
    const opened = await initialOpen(args); f.tabs.get(opened.tabId)!.url = finalUrl;
    opened.nav.outcome.finalUrl = finalUrl;
    return opened;
  });
  expect((await f.reader.read(a))).toMatchObject({ status: 'readable', document: { url: finalUrl } });
  expect(f.tabs.get('tab-1')!.owner).toBe('thread-a');
  const gate = deferred<'accepted'>();
  const pending = f.reader.read({ ...a, mode: 'capture_existing', attemptId: 'retry', onDocument: () => gate.promise });
  await flush(); f.tabs.get('tab-1')!.url = 'https://article.example/other'; f.tabs.get('tab-1')!.sequence++;
  gate.resolve('accepted');
  expect(await pending).toMatchObject({ status: 'waiting_user', reason: 'user_navigated' });
  expect(f.tabs.get('tab-1')!.owner).toBeNull();
  await f.reader.release(a, { closeOwned: true });
  expect(f.tabs.has('tab-1')).toBe(true);
  // Positive cleanup control, in this same case, still closes a task-owned tab.
  await f.reader.openForUser(a); expect(f.tabs.has('tab-2')).toBe(true); await f.reader.release(a, { closeOwned: true });
  expect(f.tabs.has('tab-2')).toBe(false);
  await f.reader.dispose();
});

it('notifies retained source leases after waiting, ignores replaced associations, and honors unsubscribe/dispose', async () => {
  const f = fixture(), a = f.input(), events = vi.fn();
  const off = f.reader.onLeaseUnavailable?.(events);
  const read = await f.reader.read(a);
  expect(read).toMatchObject({status:'readable', leaseId: expect.any(String)});
  f.tabs.get('tab-1')!.capture = async () => ({status:'pending',reason:'verification_widget',revision:0});
  const waiting = await f.reader.read({...a,mode:'capture_existing',attemptId:'waiting-attempt'});
  expect(waiting).toMatchObject({status:'waiting_user',leaseId:expect.any(String)});
  expect(waiting.leaseId).toBe(read.leaseId);
  for (const fn of f.destroyed) fn('tab-1','tab_evicted');
  expect(events).toHaveBeenCalledWith({threadId:'thread-a',researchRunId:'run-a',sourceId:'source-a',attemptId:'waiting-attempt',leaseId:waiting.leaseId,reason:'tab_evicted'});
  const newer = await f.reader.openForUser({...a,attemptId:'newer-attempt'});
  expect(newer).toMatchObject({tabId:'tab-2',leaseId:expect.any(String)});
  expect(newer.leaseId).not.toBe(waiting.leaseId);
  for (const fn of f.destroyed) fn('tab-1','tab_closed');
  expect(events).toHaveBeenCalledTimes(1);
  for (const fn of f.unavailable) fn('tab-2','oom');
  expect(events).toHaveBeenLastCalledWith({threadId:'thread-a',researchRunId:'run-a',sourceId:'source-a',attemptId:'newer-attempt',leaseId:newer.leaseId,reason:'renderer_crashed:oom'});
  off?.();
  const last = await f.reader.openForUser({...a,attemptId:'last'});
  for (const fn of f.destroyed) fn(last.tabId,'tab_closed');
  expect(events).toHaveBeenCalledTimes(2);
  expect(f.destroyed.size).toBe(1); expect(f.unavailable.size).toBe(1);
  f.reader.onLeaseUnavailable?.(events);
  await f.reader.openForUser({...a,attemptId:'dispose-current'});
  await f.reader.dispose();
  expect(events).toHaveBeenCalledTimes(2);
  expect(f.destroyed.size).toBe(0); expect(f.unavailable.size).toBe(0);
});

it('returns a live current lease from openForUser even when activation loses the tab', async () => {
  const f = fixture(), a = f.input();
  const opened = await f.reader.openForUser(a);
  expect(f.reader.currentTab(a)).toBe(opened.tabId);
  f.browser.activate.mockImplementation((id: string) => { f.browser.close(id); });
  await expect(f.reader.openForUser(a)).rejects.toThrow('tab_closed');
  await f.reader.dispose();
});

it('preserves reservation failures on explicit retry even when the previous lease is unavailable', async () => {
  const f = fixture(), a = f.input(), error = new Error('budget reservation must be mapped by its owner');
  expect((await f.reader.read(a)).status).toBe('readable');
  for (const fn of f.unavailable) fn('tab-1','oom');
  await expect(f.reader.read({...a, mode:'navigate',attemptId:'retry',beforeNavigate:async()=>{throw error;}})).rejects.toBe(error);
  await f.reader.dispose();
});

it('releases driving and the global slot at the read deadline even if CDP cleanup is still pending', async () => {
  vi.useFakeTimers();
  const f = fixture(), a = f.input();
  expect((await f.reader.read(a)).status).toBe('readable');
  f.tabs.get('tab-1')!.capture = async () => ({status:'pending',reason:'article_root_missing',revision:0});
  const observe = f.browser.observeResearchDocument.getMockImplementation()!, cleanup = deferred<void>();
  f.browser.observeResearchDocument.mockImplementation(async args => ({...await observe(args),dispose:()=>cleanup.promise}));
  let result: unknown;
  const reading = f.reader.read({...a,mode:'capture_existing'}).then(value=>{result=value;});
  await flush(); expect(f.stats().driving).toBe(1);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(result).toMatchObject({status:'waiting_user',reason:'browser_read_timeout'});
  expect(f.stats().driving).toBe(0);
  cleanup.resolve(); await reading; await f.reader.dispose();
});

it('passes the exact remaining DOM allowance to capture and rejects oversize without parsing another document', async () => {
  const f = fixture(), callback = vi.fn(async () => 'accepted' as const), a = f.input({onDocument:callback});
  expect((await f.reader.read(a)).status).toBe('readable');
  expect(callback).toHaveBeenCalledTimes(1);
  f.tabs.get('tab-1')!.capture = async remaining => {
    expect(remaining).toBe(37);
    return {status:'oversize',revision:1,utf8Bytes:38,mainStatusCode:200};
  };
  expect(await f.reader.read({...a, mode:'capture_existing',remainingDomBytes:async()=>37})).toMatchObject({status:'budget_blocked',reason:'browser_dom_budget',mainStatusCode:200,finalUrl:url});
  expect(callback).toHaveBeenCalledTimes(1);
  await f.reader.dispose();
});

it('handles a callback cancelling synchronously without leaving an unhandled rejected owner promise', async () => {
  const f = fixture(), cancel = new AbortController(), cancelled = new Error('owner cancellation'), callbackError = new Error('reservation aborted');
  await expect(f.reader.read(f.input({signal:cancel.signal,beforeNavigate:async()=>{cancel.abort(cancelled);throw callbackError;}}))).rejects.toBe(cancelled);
  await flush();
  expect((await f.reader.read(f.input())).status).toBe('readable');
  await f.reader.dispose();
});

it('invalidates a pending user reservation on source release and lets a fresh source action succeed', async () => {
  const f = fixture(), a = f.input();
  const initial = await f.reader.openForUser(a);
  expect(f.reader.currentTab(a)).toBe(initial.tabId);
  await f.reader.release(a,{closeOwned:true});
  const reservation = deferred<void>();
  const pending = f.reader.openForUser({...a,beforeNavigate:()=>reservation.promise});
  const settled = pending.then(value=>({value}),error=>({error}));
  await flush(); await f.reader.release(a,{closeOwned:true});
  reservation.resolve();
  expect(await settled).toMatchObject({error:expect.any(Error)});
  expect(f.browser.open).toHaveBeenCalledTimes(1);
  expect(f.reader.currentTab(a)).toBeUndefined();
  const fresh = await f.reader.openForUser(a);
  expect(f.reader.currentTab(a)).toBe(fresh.tabId);
  await f.reader.dispose();
});

it('closes a stale user-open receipt after release while preserving a newer source association', async () => {
  const f = fixture(), a = f.input();
  const first = await f.reader.openForUser(a);
  expect(f.tabs.has(first.tabId)).toBe(true);
  await f.reader.release(a,{closeOwned:true});
  const open = f.browser.open.getMockImplementation()!, receipt = deferred<Awaited<ReturnType<typeof open>>>();
  let oldReceipt: Awaited<ReturnType<typeof open>> | undefined;
  f.browser.open.mockImplementationOnce(async args=>{oldReceipt=await open(args);return receipt.promise;});
  const pending = f.reader.openForUser(a).then(value=>({value}),error=>({error}));
  await flush(); expect(f.tabs.has('tab-2')).toBe(true);
  await f.reader.release(a,{closeOwned:true});
  const fresh = await f.reader.openForUser(a);
  expect(f.reader.currentTab(a)).toBe(fresh.tabId);
  receipt.resolve(oldReceipt!); await flush();
  expect(await pending).toMatchObject({error:expect.any(Error)});
  expect(f.tabs.has('tab-2')).toBe(false);
  expect(f.tabs.has(fresh.tabId)).toBe(true);
  expect(f.reader.currentTab(a)).toBe(fresh.tabId);
  expect(f.browser.activate).toHaveBeenCalledTimes(2);
  await f.reader.dispose();
});

it.each([false,true])('preserves an owner callback failure with synchronous cleanup=%s while retaining cleanup-only failures', async synchronous => {
  const f = fixture(), a = f.input(), ownerError = new Error('owner persistence failed'), cleanupError = new Error('cleanup CDP failed');
  expect((await f.reader.read(a)).status).toBe('readable');
  const observe = f.browser.observeResearchDocument.getMockImplementation()!;
  f.browser.observeResearchDocument.mockImplementation(async args=>({...await observe(args),dispose:()=>{if(synchronous)throw cleanupError;return Promise.reject(cleanupError);}}));
  await expect(f.reader.read({...a,mode:'capture_existing'})).rejects.toBe(cleanupError);
  await expect(f.reader.read({...a,mode:'capture_existing',onDocument:async()=>{throw ownerError;}})).rejects.toBe(ownerError);
  expect(f.stats().driving).toBe(0);
  await f.reader.dispose();
});

it.each([false,true])('rechecks a deferred observer setup navigation and rejects foreign pending targets=%s', async foreign => {
  const f = fixture(), callback = vi.fn(async()=>'accepted' as const), a = f.input({onDocument:callback});
  expect((await f.reader.read(a)).status).toBe('readable');
  expect(callback).toHaveBeenCalledTimes(1);
  const entered = deferred<void>(), setup = deferred<void>();
  f.browser.observeResearchDocument.mockImplementationOnce(async()=>{
    entered.resolve(); await setup.promise;
    throw new ResearchDocumentInvalidatedError('document_navigation');
  });
  const reading = f.reader.read({...a,mode:'capture_existing',attemptId:'setup-navigation'}).then(value=>({value}),error=>({error}));
  await entered.promise;
  const tab = f.tabs.get('tab-1')!;
  tab.sequence++; tab.navigationEvent='did-start-navigation'; tab.navigationType='cross_document';
  tab.navigationUrl=foreign?'https://article.example/foreign':url;
  setup.resolve(); await flush();
  if (!foreign) {
    expect(f.browser.waitForResearchNavigation).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledTimes(1);
    tab.epoch++; tab.sequence++; tab.navigationEvent='did-navigate';
    for(const wake of f.wake) wake(); f.wake.clear();
    expect(await reading).toMatchObject({value:{status:'readable',document:{identity:{documentEpoch:2,navigationSequence:4}}}});
    expect(callback).toHaveBeenCalledTimes(2);
    expect(f.browser.observeResearchDocument).toHaveBeenCalledTimes(3);
  } else {
    expect(await reading).toMatchObject({value:{status:'waiting_user',reason:'user_navigated',finalUrl:'https://article.example/foreign'}});
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.browser.observeResearchDocument).toHaveBeenCalledTimes(2);
  }
  expect(a.beforeNavigate).toHaveBeenCalledTimes(1);
  await f.reader.dispose();
});

it('does not treat CDP or owner navigation-message lookalikes as setup invalidation', async () => {
  const f = fixture(), a = f.input();
  expect((await f.reader.read(a)).status).toBe('readable');
  for(const error of [new Error('document_navigation'),new ResearchDocumentInvalidatedError('document_navigation')]) {
    await expect(f.reader.read({...a,mode:'capture_existing',onDocument:async()=>{throw error;}})).rejects.toBe(error);
    await expect(f.reader.read({...a,mode:'navigate',beforeNavigate:async()=>{throw error;}})).rejects.toBe(error);
  }
  const cdpError = new Error('document_navigation');
  f.browser.observeResearchDocument.mockImplementationOnce(async()=>{throw cdpError;});
  await expect(f.reader.read({...a,mode:'capture_existing'})).rejects.toBe(cdpError);
  expect(f.browser.observeResearchDocument).toHaveBeenCalledTimes(4);
  expect(f.browser.open).toHaveBeenCalledTimes(1);
  await f.reader.dispose();
});

it('keeps the original read deadline after setup invalidation and allows a fresh later retry', async () => {
  vi.useFakeTimers();
  const f = fixture(), a = f.input();
  expect((await f.reader.read(a)).status).toBe('readable');
  const setup = deferred<void>();
  f.browser.observeResearchDocument.mockImplementationOnce(async()=>{await setup.promise;throw new ResearchDocumentInvalidatedError('document_identity_changed');});
  f.tabs.get('tab-1')!.capture=async()=>({status:'pending',reason:'article_root_missing',revision:0});
  const reading=f.reader.read({...a,mode:'capture_existing'});
  await flush(); await vi.advanceTimersByTimeAsync(29_000);
  f.tabs.get('tab-1')!.epoch++; f.tabs.get('tab-1')!.sequence++;
  setup.resolve(); await flush();
  expect(f.browser.observeResearchDocument).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await reading).toMatchObject({status:'waiting_user',reason:'browser_read_timeout'});
  expect(f.stats().driving).toBe(0);
  f.tabs.get('tab-1')!.capture=async()=>({status:'snapshot',revision:1,document:f.snapshot('tab-1')});
  expect((await f.reader.read({...a,mode:'capture_existing'})).status).toBe('readable');
  await f.reader.dispose();
});
