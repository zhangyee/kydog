import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { NetworkResponseObserver } from './networkResponses';
import type { BrowserLocationFacts } from './browserService';

const location: BrowserLocationFacts = { currentUrl: 'https://example.org/page', documentEpoch: 2, routeRevision: 3,
  navigationEvent: 'did-navigate', navigationSequence: 4, navigationType: 'cross_document', navigationUrl: 'https://example.org/page' };
function harness() {
  const debugger_ = new EventEmitter() as EventEmitter & { sendCommand: ReturnType<typeof vi.fn> };
  debugger_.sendCommand = vi.fn(async (method: string, _params?: object, _sessionId?: string) => method === 'Page.getFrameTree'
    ? { frameTree: { frame: { id: 'frame', loaderId: 'loader' } } } : { body: '汉🙂\n', base64Encoded: false });
  let facts = { ...location };
  const observer = new NetworkResponseObserver(debugger_ as never, 'tab', { ownerId: 'owner', accepts: r => r.url.includes('/body') }, () => facts);
  const emit = (method: string, params: object, sessionId = '') => debugger_.emit('message', {}, method, params, sessionId);
  const request = (requestId = 'a', extra: object = {}, sessionId?: string) => emit('Network.requestWillBeSent', {
    requestId, loaderId: 'loader', frameId: 'frame', request: { url: 'https://example.org/body', method: 'POST', postData: 'query' }, ...extra,
  }, sessionId);
  const response = (requestId = 'a', sessionId?: string) => emit('Network.responseReceived', { requestId, response: { status: 207 } }, sessionId);
  const finish = (requestId = 'a', sessionId?: string) => emit('Network.loadingFinished', { requestId, encodedDataLength: 8 }, sessionId);
  return { debugger_, observer, lease: observer.lease, emit, request, response, finish, route: () => { facts = { ...facts, routeRevision: 99 }; } };
}

describe('NetworkResponseObserver', () => {
  it('reads only accepted completed bodies and preserves request-time identity, bytes and hash', async () => {
    const h = harness(); await h.observer.enable();
    expect(h.debugger_.sendCommand.mock.calls.find(c => c[0] === 'Network.enable')).toEqual(['Network.enable', { maxTotalBufferSize: 67108864, maxResourceBufferSize: 16777216, maxPostDataSize: 65536 }]);
    h.request(); h.route(); h.response();
    expect((await h.lease.drain()).map(e => e.kind)).toEqual(['request']);
    h.finish();
    const [event] = await h.lease.drain();
    expect(event).toMatchObject({ kind: 'response', status: 207, body: '汉🙂\n', bytes: 8,
      sha256: createHash('sha256').update(Buffer.from('汉🙂\n')).digest('hex'), request: { sessionId: null, requestId: 'a', redirectIndex: 0,
        loaderId: 'loader', frameId: 'frame', location, navigationId: JSON.stringify([null, 'frame', 'loader']) } });
    expect(h.debugger_.sendCommand.mock.calls.filter(c => c[0] === 'Network.getResponseBody')).toHaveLength(1);
    h.request('ignored', { request: { url: 'https://example.org/image', method: 'GET' } }); h.response('ignored'); h.finish('ignored');
    expect(await h.lease.drain()).toEqual([]);
    expect(h.debugger_.sendCommand.mock.calls.filter(c => c[0] === 'Network.getResponseBody')).toHaveLength(1);
    await h.lease.close('done');
  });

  it('keeps redirect hops, overlapping requests and CDP sessions distinct; unknown loader stays unknown', async () => {
    const h = harness(); await h.observer.enable();
    h.request('same'); h.request('same', { redirectResponse: { status: 302 } });
    h.request('same', { loaderId: 'other-loader' }, 'child'); h.request('later');
    h.response('later'); h.finish('later'); h.response('same', 'child'); h.finish('same', 'child'); h.response('same'); h.finish('same');
    const events = await h.lease.drain();
    const requests = events.filter(e => e.kind === 'request').map(e => e.request);
    expect(new Set(requests.map(r => r.id)).size).toBe(4);
    expect(requests.map(r => [r.requestId, r.redirectIndex, r.sessionId, r.navigationId])).toEqual([
      ['same', 0, null, JSON.stringify([null, 'frame', 'loader'])], ['same', 1, null, JSON.stringify([null, 'frame', 'loader'])],
      ['same', 0, 'child', ''], ['later', 0, null, JSON.stringify([null, 'frame', 'loader'])],
    ]);
    expect(events.filter(e => e.kind === 'response').map(e => e.request.id)).toEqual([requests[3].id, requests[2].id, requests[1].id]);
    expect(h.debugger_.sendCommand.mock.calls.filter(c => c[0] === 'Network.getResponseBody')).toEqual([
      ['Network.getResponseBody', { requestId: 'later' }], ['Network.getResponseBody', { requestId: 'same' }, 'child'],
      ['Network.getResponseBody', { requestId: 'same' }],
    ]);
    expect(events.filter(e => e.kind === 'failed')).toMatchObject([{ reason: 'body_unavailable', request: { redirectIndex: 0 } }]);
    await h.lease.close('done');
  });

  it('hashes original base64 bytes and rejects invalid UTF8 instead of normalizing bytes', async () => {
    const h = harness(); await h.observer.enable();
    h.debugger_.sendCommand.mockResolvedValue({ body: Buffer.from('�🙂').toString('base64'), base64Encoded: true });
    h.request(); h.response(); h.finish();
    expect((await h.lease.drain()).find(e => e.kind === 'response')).toMatchObject({ body: '�🙂', bytes: 7, sha256: createHash('sha256').update('�🙂').digest('hex') });
    h.debugger_.sendCommand.mockResolvedValue({ body: Buffer.from([255]).toString('base64'), base64Encoded: true });
    h.request('bad'); h.response('bad'); h.finish('bad');
    expect((await h.lease.drain()).find(e => e.kind === 'failed')).toMatchObject({ reason: 'body_unavailable' });
    await h.lease.close('done');
  });

  it('reports loading, body rejection and decoded body limit failures explicitly', async () => {
    const h = harness(); await h.observer.enable();
    h.request(); h.response(); h.finish();
    expect((await h.lease.drain()).some(e => e.kind === 'response')).toBe(true);
    h.request('failed'); h.emit('Network.loadingFailed', { requestId: 'failed' });
    h.debugger_.sendCommand.mockRejectedValueOnce(new Error('unavailable'));
    h.request('rejected'); h.response('rejected'); h.finish('rejected');
    await h.lease.drain().then(events => expect(events.filter(e => e.kind === 'failed').map(e => e.reason)).toEqual(['loading_failed', 'body_unavailable']));
    h.debugger_.sendCommand.mockResolvedValueOnce({ body: 'x'.repeat(16777217), base64Encoded: false });
    h.request('limit'); h.response('limit'); h.finish('limit');
    expect((await h.lease.drain()).find(e => e.kind === 'failed')).toMatchObject({ reason: 'body_limit' });
    await h.lease.close('done');
  });

  it('drain waits for already-associated body reads, close releases queues and leaves foreign listeners', async () => {
    const h = harness(); const foreign = vi.fn(); h.debugger_.on('message', foreign); await h.observer.enable();
    h.request(); h.response(); h.finish(); expect((await h.lease.drain()).some(e => e.kind === 'response')).toBe(true);
    let resolve!: (v: object) => void;
    h.debugger_.sendCommand.mockImplementation(() => new Promise(r => { resolve = r; }));
    h.request('pending'); h.response('pending'); h.finish('pending');
    let settled = false; const draining = h.lease.drain().then(events => { settled = true; return events; });
    await Promise.resolve(); expect(settled).toBe(false);
    resolve({ body: 'late', base64Encoded: false });
    expect((await draining).map(e => e.kind)).toEqual(['request', 'response']);
    h.request('late'); h.response('late'); h.finish('late');
    await h.lease.close('closed'); resolve({ body: 'discard', base64Encoded: false });
    expect(await h.lease.take(undefined, 100)).toEqual({ kind: 'closed', reason: 'closed' });
    expect(h.debugger_.listeners('message')).toEqual([foreign]);
    expect(await h.lease.drain()).toEqual([]);
  });

  it('cancelled waiter closes lease; timeout does not cancel capture', async () => {
    const h = harness(); await h.observer.enable();
    h.request(); expect((await h.lease.take(undefined, 100)).kind).toBe('request');
    await expect(h.lease.take(undefined, 1)).rejects.toThrow('timeout');
    h.response(); h.finish(); expect((await h.lease.take(undefined, 100)).kind).toBe('response');
    const abort = new AbortController(); const waiter = h.lease.take(abort.signal, 100); abort.abort();
    expect(await waiter).toEqual({ kind: 'closed', reason: 'cancelled' });
    h.request('after'); expect(await h.lease.drain()).toEqual([]);
  });
  it('late body cannot enter a new lease; frame/loader/session and route facts stay distinct', async () => {
    const h = harness(); await h.observer.enable();
    h.request('ok'); h.response('ok'); h.finish('ok');
    expect((await h.lease.drain()).some(e => e.kind === 'response')).toBe(true);
    let complete!: (value: object) => void;
    h.debugger_.sendCommand.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    h.request(); h.response(); h.finish();
    await h.lease.close('superseded');
    const next = new NetworkResponseObserver(h.debugger_ as never, 'tab', { ownerId: 'next', accepts: () => true }, () => ({ ...location, routeRevision: 88 }));
    await next.enable();
    complete({ body: 'old-body', base64Encoded: false }); await Promise.resolve();
    h.emit('Page.frameNavigated', { frame: { id: 'frame', loaderId: 'new-loader' } });
    h.request('new', { loaderId: 'new-loader' }); h.request('old-loader'); h.request('other-session', {}, 'child');
    const events = await next.lease.drain();
    expect(events.filter(e => e.kind === 'request').map(e => [e.request.navigationId, e.request.location.routeRevision])).toEqual([
      [JSON.stringify([null, 'frame', 'new-loader']), 88], ['', 88], ['', 88],
    ]);
    expect(events.filter(e => e.kind === 'response')).toEqual([]);
    expect(await h.lease.drain()).toEqual([]);
    await next.close('done');
  });

  it('close during enable prevents later CDP commands and removes only its listener', async () => {
    const h = harness(); await h.observer.enable();
    expect(h.debugger_.sendCommand.mock.calls.map(c => c[0])).toContain('Network.enable');
    await h.observer.close('first');
    let done!: (value: object) => void;
    h.debugger_.sendCommand.mockClear().mockImplementation(() => new Promise(resolve => { done = resolve; }));
    const next = new NetworkResponseObserver(h.debugger_ as never, 'tab', { ownerId: 'next', accepts: () => true }, () => location);
    const enabling = next.enable(); expect(h.debugger_.listenerCount('message')).toBe(1);
    await next.close('cancelled'); await enabling;
    done({}); await Promise.resolve();
    expect(h.debugger_.sendCommand.mock.calls.map(c => c[0])).toEqual(['Page.enable']);
    expect(h.debugger_.listenerCount('message')).toBe(0);
  });

  it('bounds accepted pending request storage even when consumers drain the event queue', async () => {
    const h = harness(); await h.observer.enable();
    h.request('positive'); expect((await h.lease.take(undefined, 100)).kind).toBe('request');
    for (let i = 0; i < 1100; i++) {
      h.request(String(i), { request: { url: 'https://example.org/body', method: 'POST', postData: 'x'.repeat(65536) } });
      await h.lease.drain();
    }
    expect(await h.lease.take(undefined, 1)).toEqual({ kind: 'closed', reason: 'buffer_limit' });
  });

  it('marks an unobserved redirect prefix unknown and keeps subsequent orphan hops distinct', async () => {
    const h = harness(); await h.observer.enable();
    h.request('ordinary'); h.request('ordinary', { redirectResponse: { status: 302 } });
    h.request('orphan', { redirectResponse: { status: 302 } });
    h.request('orphan', { redirectResponse: { status: 307 } });
    const requests = (await h.lease.drain()).filter(e => e.kind === 'request').map(e => e.request);
    expect(requests.map(r => r.redirectIndex)).toEqual([0, 1, -1, -1]);
    expect(new Set(requests.map(r => r.id)).size).toBe(4);
    await h.lease.close('done');
  });

  it('freezes proven global main-frame identity, distinguishes same-session children and unknown frames', async () => {
    const h=harness();await h.observer.enable();h.request('main');
    h.emit('Page.frameNavigated',{frame:{id:'child-frame',parentId:'frame',loaderId:'child-loader'}});
    h.request('iframe',{frameId:'child-frame',loaderId:'child-loader'});
    h.emit('Page.frameNavigated',{frame:{id:'oop-root',loaderId:'oop-loader'}},'oop');
    h.request('oop',{frameId:'oop-root',loaderId:'oop-loader'},'oop');
    h.request('missing',{frameId:'absent'});
    h.emit('Page.frameDetached',{frameId:'frame'});
    const requests=(await h.lease.drain()).filter(e=>e.kind==='request').map(e=>e.request);
    expect(requests.map(r=>r.isMainFrame)).toEqual([true,false,false,null]);
    expect(Object.isFrozen(requests[0])).toBe(true);
    await h.lease.close('done');
  });

});
