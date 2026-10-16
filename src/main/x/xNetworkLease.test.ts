import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import first from '../../test-support/fixtures/x-network/search-top-initial.json';
import next from '../../test-support/fixtures/x-network/search-top-next.json';
import { XNetworkSearchLease } from './xNetworkLease';
import { logger } from '../log';
import type {
  BrowserNetworkEvent,
  BrowserNetworkRequest,
} from '../browser/networkResponses';
const location = {
  currentUrl: 'https://x.com/search?q=from%3ACaptureAuthor&f=top',
  documentEpoch: 2,
  routeRevision: 3,
  navigationSequence: 4,
  navigationEvent: 'did-navigate' as const,
  navigationType: 'cross_document' as const,
  navigationUrl: null,
};
const query = {
  id: 'q',
  purpose: 'test',
  query: 'from:CaptureAuthor',
  product: 'Top' as const,
};
function req(
  variables: object = first.request,
  changes: Partial<BrowserNetworkRequest> = {},
): BrowserNetworkRequest {
  return {
    id: 'source-1',
    requestId: 'r',
    sessionId: null,
    redirectIndex: 0,
    isMainFrame: true,
    frameId: 'f',
    loaderId: 'l',
    navigationId: '[null,"f","l"]',
    location: { ...location },
    method: 'GET',
    url:
      'https://x.com/i/api/graphql/recorded-operation/SearchTimeline?variables=' +
      encodeURIComponent(JSON.stringify(variables)),
    ...changes,
  };
}
function harness() {
  const events: BrowserNetworkEvent[] = [];
  const lease = new XNetworkSearchLease(query, location.currentUrl);
  const source = {
    id: 'source',
    tabId: 'tab',
    drain: vi.fn(async () => events.splice(0)),
    take: vi.fn(async () => {
      const event = events.shift();
      if (!event) throw new Error('network_response_timeout');
      return event;
    }),
    close: vi.fn(async () => {}),
  };
  lease.bind(source);
  const emit = (r: BrowserNetworkRequest, body: object = first.body) => {
    const str = JSON.stringify(body);
    events.push({
      kind: 'response',
      request: r,
      status: 200,
      retryAfterMs: null,
      body: str,
      bytes: Buffer.byteLength(str),
      sha256: createHash('sha256').update(str).digest('hex'),
    });
  };
  return { lease, events, source, emit };
}
it('logs token-free visibility of operation-matching requests for later alignment', async () => {
  const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  try {
    const h = harness();
    // A different operation on the same host is not a sighting at all.
    const unrelated = req(first.request, {
      id: 'u',
      url: 'https://x.com/i/api/graphql/hash/HomeTimeline?variables=' + encodeURIComponent('{}'),
    });
    expect(h.lease.accepts(unrelated)).toBe(false);
    expect(info.mock.calls.filter(([, msg]) => msg === 'network_lease_request')).toHaveLength(0);
    // Our operation but rejected: the finite reason is recorded, no cursor token.
    const wrongLocation = req(first.request, {
      id: 'w',
      location: { ...location, currentUrl: 'https://x.com/home' },
    });
    expect(h.lease.accepts(wrongLocation)).toBe(false);
    expect(
      info.mock.calls.find(([, msg]) => msg === 'network_lease_request')?.[2],
    ).toMatchObject({ operation: 'SearchTimeline', accepted: false, reason: 'location_mismatch', hasInputCursor: false });
    const accepted = req();
    expect(h.lease.accepts(accepted)).toBe(true);
    h.emit(accepted);
    await h.lease.collect(location);
    expect(
      info.mock.calls.find(([, msg]) => msg === 'network_lease_collect')?.[2],
    ).toMatchObject({ operation: 'SearchTimeline', seen: 2, accepted: 1, rejected: 1, reasons: { location_mismatch: 1 } });
  } finally {
    info.mockRestore();
  }
});

it('keeps a non-200 HTTP status as a protocol fact instead of one collapsed word', async () => {
  const h = harness();
  const request = req();
  expect(h.lease.accepts(request)).toBe(true);
  const str = JSON.stringify(first.body);
  h.events.push({
    kind: 'response', request, status: 429, retryAfterMs: 120_000, body: str,
    bytes: Buffer.byteLength(str), sha256: createHash('sha256').update(str).digest('hex'),
  });
  await expect(h.lease.collect(location)).rejects.toThrow('source_unavailable:http_status:429');
});

describe('search request-time leases', () => {
  it('accepts before open finishes and chains exact recorded cursors', async () => {
    const h = harness(),
      a = req();
    expect(h.lease.accepts(a)).toBe(true);
    h.emit(a);
    const one = await h.lease.collect(location);
    expect(one.pages[0].posts).toHaveLength(20);
    const b = req(next.request, { id: 'source-2' });
    expect(h.lease.accepts(b)).toBe(true);
    h.emit(b, next.body);
    expect((await h.lease.collect(location)).pages[0].inputCursor).toBe(
      one.pages[0].outputCursor,
    );
  });
  it('rejects each wrong source coordinate after the positive control in the same case', async () => {
    const variations: Partial<BrowserNetworkRequest>[] = [
      { isMainFrame: false },
      { isMainFrame: null },
      { sessionId: 'child' },
      { redirectIndex: -1 },
      { navigationId: '' },
      { url: req().url.replace('https:', 'http:') },
      { url: req().url.replace('x.com', 'evil.example') },
      { url: req().url.replace('SearchTimeline', 'Other') },
      { location: { ...location, documentEpoch: 99 } },
      { location: { ...location, routeRevision: 99 } },
      { location: { ...location, navigationSequence: 99 } },
      { navigationId: 'other' },
      {
        location: {
          ...location,
          currentUrl: location.currentUrl.replace('top', 'live'),
        },
      },
    ];
    for (const patch of variations) {
      const h = harness();
      expect(h.lease.accepts(req())).toBe(true);
      h.emit(req());
      expect((await h.lease.collect(location)).pages).toHaveLength(1);
      expect(
        h.lease.accepts(req({ ...next.request }, { id: 'bad', ...patch })),
      ).toBe(false);
    }
    for (const vars of [
      { ...next.request, rawQuery: 'wrong' },
      { ...next.request, product: 'Latest' },
      { ...next.request, cursor: 'wrong' },
      { ...next.request, cursor: undefined },
    ]) {
      const h = harness();
      expect(h.lease.accepts(req())).toBe(true);
      h.emit(req());
      await h.lease.collect(location);
      expect(h.lease.accepts(req(vars, { id: 'bad' }))).toBe(false);
    }
  });
  it('rejects changed generation at response time and explicit source closure', async () => {
    const h = harness();
    expect(h.lease.accepts(req())).toBe(true);
    h.emit(req());
    expect((await h.lease.collect(location)).pages).toHaveLength(1);
    const b = req(next.request, { id: 'next' });
    expect(h.lease.accepts(b)).toBe(true);
    h.emit(b, next.body);
    await expect(
      h.lease.collect({ ...location, routeRevision: 10 }),
    ).rejects.toThrow('source_unavailable');
    const closed = harness();
    closed.events.push({ kind: 'closed', reason: 'detached' });
    await expect(closed.lease.collect(location)).rejects.toThrow('detached');
  });
  it('retains public byte/hash and opaque references without raw cursor or URL parameters', async () => {
    const h = harness();
    const a = req();
    expect(h.lease.accepts(a)).toBe(true);
    h.emit(a);
    await h.lease.collect(location);
    const facts = h.lease.pageFacts;
    expect(facts[0]).toMatchObject({
      bytes: Buffer.byteLength(JSON.stringify(first.body)),
      sha256: createHash('sha256')
        .update(JSON.stringify(first.body))
        .digest('hex'),
    });
    expect(facts[0].outputCursorRef).toBeTruthy();
    expect(JSON.stringify(facts)).not.toContain('fixture-cursor');
    expect(JSON.stringify(facts)).not.toContain('variables=');
  });
  it('surfaces cleanup failure as a finite fact', async () => {
    const h = harness();
    h.source.close.mockRejectedValueOnce(new Error('private'));
    expect(await h.lease.close()).toBe('network_cleanup_failed');
  });
});

it('waits for an already bound response arriving after the first drain', async () => {
  const h = harness();
  const a = req();
  expect(h.lease.accepts(a)).toBe(true);
  h.source.take.mockImplementationOnce(async () => {
    h.emit(a);
    return h.events.shift()!;
  });
  expect((await h.lease.collect(location)).pages[0].posts).toHaveLength(20);
  expect(h.source.take).toHaveBeenCalledOnce();
});
it('accepts recorded out-of-order completion only through an exact input/output link', async () => {
  const h = harness(),
    a = req(),
    b = req(next.request, { id: 'next' });
  expect(h.lease.accepts(a)).toBe(true);
  expect(h.lease.accepts(b)).toBe(true);
  h.emit(b, next.body);
  h.emit(a);
  expect(
    (await h.lease.collect(location)).pages.map((p) => p.inputCursor),
  ).toEqual([null, next.request.cursor]);
});
it('returns already decoded facts beside later lifecycle failure', async () => {
  const h = harness(),
    a = req();
  expect(h.lease.accepts(a)).toBe(true);
  h.emit(a);
  h.events.push({ kind: 'closed', reason: 'detached' });
  expect(await h.lease.collect(location)).toMatchObject({
    pages: [{ posts: expect.any(Array) }],
    failure: 'detached',
  });
});

it('distinguishes a missing accepted response from exhaustion, preserving earlier pages', async () => {
  const h = harness();
  const a = req();
  expect(h.lease.accepts(a)).toBe(true);
  h.emit(a);
  expect((await h.lease.collect(location)).pages).toHaveLength(1);
  expect(h.lease.accepts(req(next.request, { id: 'missing' }))).toBe(true);
  expect(await h.lease.collect(location)).toMatchObject({
    pages: [],
    failure: 'wait_timeout',
  });
});

it('delivers accepted pages before waiting on a pending successor, retaining them across later cancellation', async () => {
  const h = harness(),
    a = req(),
    b = req(next.request, { id: 'pending-next' });
  expect(h.lease.accepts(a)).toBe(true);
  expect(h.lease.accepts(b)).toBe(true);
  h.emit(a);
  const firstBatch = await h.lease.collect(location);
  expect(firstBatch.pages).toHaveLength(1);
  expect(firstBatch).toMatchObject({ pending: true });
  expect(firstBatch.failure).toBeUndefined();
  h.events.push({ kind: 'closed', reason: 'cancelled' });
  expect(await h.lease.collect(location)).toMatchObject({
    pages: [],
    failure: 'cancelled',
  });
});

it('preserves cancellation while awaiting a bound successor instead of relabeling it timeout', async () => {
  const h = harness(), a = req();
  expect(h.lease.accepts(a)).toBe(true);
  h.emit(a);
  expect((await h.lease.collect(location)).pages).toHaveLength(1);
  expect(h.lease.accepts(req(next.request, { id: 'cancelled-next' }))).toBe(true);
  const controller = new AbortController();
  h.source.take.mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('network_cancelled');
  });
  expect(await h.lease.collect(location, controller.signal)).toMatchObject({
    failure: 'cancelled', pending: false,
  });
});

it('delivers prior accepted pages when a later decoder unexpectedly fails', async () => {
  const decoder=await import('./xNetworkSource');
  const decode=decoder.decodeXSearchResponse;
  const h=harness(), a=req(), b=req(next.request,{id:'next'});
  expect(h.lease.accepts(a)).toBe(true);expect(h.lease.accepts(b)).toBe(true);
  h.emit(a);h.emit(b,next.body);
  const spy=vi.spyOn(decoder,'decodeXSearchResponse').mockImplementation((body,request)=>{
    if(request.inputCursor!==null)throw new Error('private decoder error');
    return decode(body,request);
  });
  try{expect(await h.lease.collect(location)).toMatchObject({pages:[{posts:expect.any(Array)}],facts:[{observed:20}],failure:'decode_failed',pending:false});}
  finally{spy.mockRestore();}
});

it('retains a prior valid batch but rejects a successor invalidated before acceptance',async()=>{
 const h=harness(),a=req();let current={...location};
 expect(h.lease.accepts(a)).toBe(true);h.emit(a);
 const accepted=await h.lease.collect(location,undefined,()=>current);
 expect(accepted.pages[0].posts).toHaveLength(20);
 const b=req(next.request,{id:'late'});expect(h.lease.accepts(b)).toBe(true);
 h.source.take.mockImplementationOnce(async()=>{current={...location,routeRevision:99};h.emit(b,next.body);return h.events.shift()!;});
 const late=await h.lease.collect(location,undefined,()=>current);
 expect(late).toMatchObject({pages:[],facts:[],failure:'generation_changed',pending:false});
 expect(accepted.pages[0].posts).toHaveLength(20);expect(h.lease.pageFacts).toHaveLength(1);
});
