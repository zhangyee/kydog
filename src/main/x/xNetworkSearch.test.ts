import { describe, it, expect } from 'vitest';
import captured from '../../test-support/fixtures/x-network/search-top-initial.json';
import empty from '../../test-support/fixtures/x-network/search-empty-initial.json';
import { fixture, searchHtml } from '../../test-support/xResearchFixture';
import { decodeXSearchResponse } from './xNetworkSource';
import { collectFreshXPage, searchX } from './xResearchSearch';
import { parseXResearchInput } from './xResearchInput';
import { KydogError } from '../../shared/errors';
const query = {
  id: 'q',
  query: 'from:CaptureAuthor',
  purpose: 'test',
  product: 'Top' as const,
};
const input = () =>
  parseXResearchInput({
    search: { objective: 'test', queries: [query] },
  }) as Parameters<typeof searchX>[0];
// Resource stress derivation: recorded Tweet structure with controlled unique IDs.
function harness(count = 3, terminalAt = -1) {
  const f = fixture([searchHtml('')]);
  let index = 0;
  const original = f.collect.getMockImplementation()!;
  f.collect.mockImplementation(async (request) => {
    const observed = await original(request);
    const body = structuredClone(
      index === terminalAt ? empty.body : captured.body,
    );
    const page = decodeXSearchResponse(body, {
      provenance: {
        leaseId: 'lease',
        requestRef: 'request-' + index,
        navigationId: 'document',
        documentEpoch: 3,
        routeRevision: 7,
        navigationSequence: 9,
        operation: 'SearchTimeline',
        observedAt: '2026-10-15T00:00:00Z',
      },
      query,
      inputCursor: index ? 'cursor-' + index : null,
    });
    if (index !== terminalAt)
      page.posts = page.posts.slice(0, count).map((p, i) => ({
        ...p,
        postId: String(1000 + index * count + i),
        sourceUrl: `https://x.com/CaptureAuthor/status/${1000 + index * count + i}`,
      }));
    page.outputCursor = 'cursor-' + ++index;
    observed.network = { pages: [page], proof: page.provenance };
    observed.identityProven = true;
    return observed;
  });
  return f;
}
describe('exclusive network search producer', () => {
  it('crosses old 20-scroll/100-post limits and stops at the default 500 distinct budget', async () => {
    const f = harness();
    const row = (await searchX(input(), f.context)).queries[0];
    expect(row.posts).toHaveLength(500);
    expect(row.budgetUsage.scrolls).toBe(166);
    expect(row.sampleTruncation).toEqual({
      observed: 501,
      sampled: 500,
      omitted: 1,
    });
    expect(row.stopReason).toBe('budget_reached');
    expect(row.posts[499].postId).toBe('1499');
  });
  it('applies explicit zero before navigation; explicit scroll zero still collects first network page', async () => {
    const f = harness();
    const i = input();
    i.search.maxScrollsPerQuery = 1;
    await searchX(i, f.context);
    expect(f.act).toHaveBeenCalledOnce();
    f.act.mockClear();
    f.open.mockClear();
    i.search.maxScrollsPerQuery = 0;
    expect((await searchX(i, f.context)).queries[0].posts).toHaveLength(3);
    expect(f.open).toHaveBeenCalledTimes(1);
    f.open.mockClear();
    i.search.maxPostsPerQuery = 0;
    expect((await searchX(i, f.context)).queries[0].posts).toEqual([]);
    expect(f.open).toHaveBeenCalledTimes(0);
    expect(f.act).toHaveBeenCalledTimes(0);
  });
  it('stops on recorded Bottom termination and reports explicit empty only with no accepted posts', async () => {
    expect(
      (await searchX(input(), harness(3, 2).context)).queries[0],
    ).toMatchObject({
      status: 'observed',
      stopReason: 'cursor_exhausted',
      posts: expect.any(Array),
    });
    const row = (await searchX(input(), harness(3, 0).context)).queries[0];
    expect(row).toMatchObject({
      status: 'explicit_empty',
      stopReason: 'cursor_exhausted',
      posts: [],
    });
  });
  it('keeps the query row partial but keeps collecting past an unrecorded shape', async () => {
    const f = harness(3, 1);
    const collect = f.collect.getMockImplementation()!;
    let calls = 0;
    f.collect.mockImplementation(async (r) => {
      const observed = await collect(r);
      const page = observed.network!.pages[0];
      if (calls++ === 0) {
        page.unsupported = ['entry_shape'];
        page.end = 'unknown';
      }
      observed.network!.facts = [
        {
          provenance: page.provenance,
          bytes: 1,
          sha256: 'a'.repeat(64),
          inputCursorRef: null,
          outputCursorRef: null,
          end: page.end,
          observed: page.posts.length,
          sampled: page.posts.length,
          omitted: 0,
          unsupported: [...page.unsupported],
        },
      ];
      return observed;
    });
    const row = (await searchX(input(), f.context)).queries[0];
    expect(row.posts).toHaveLength(3);
    expect(row.stopReason).toBe('cursor_exhausted');
    expect(row.status).toBe('partial');
    expect(row.networkPages?.[0].unsupported).toContain('entry_shape');
    expect(f.collect).toHaveBeenCalledTimes(2);
  });

  it('re-collects after a scroll write whose acknowledgement was invalidated by the page', async () => {
    const f = fixture([searchHtml('')]);
    let index = 0, scrolls = 0;
    const original = f.collect.getMockImplementation()!;
    f.collect.mockImplementation(async (request) => {
      const observed = await original(request);
      const page = decodeXSearchResponse(
        structuredClone(index === 2 ? empty.body : captured.body),
        {
          provenance: { leaseId: 'lease', requestRef: 'request-' + index, navigationId: 'document', documentEpoch: 3, routeRevision: 7, navigationSequence: 9, operation: 'SearchTimeline', observedAt: '2026-10-15T00:00:00Z' },
          query, inputCursor: index ? 'cursor-' + (index - 1) : null,
        },
      );
      page.posts = page.posts.slice(0, 3).map((p, i) => ({ ...p, postId: String(1000 + index * 3 + i), sourceUrl: `https://x.com/CaptureAuthor/status/${1000 + index * 3 + i}` }));
      page.outputCursor = 'cursor-' + index;
      index++;
      observed.network = { pages: [page], proof: page.provenance };
      observed.identityProven = true;
      return observed;
    });
    f.act.mockImplementation(async (action, snapshot, opts) => {
      const ack = opts!.scrollAcknowledgement!;
      ack.onWritten();
      const attempt = ++scrolls;
      const base = { generation: (snapshot as import('../browser/snapshot').AxSnapshot).generation, targetKind: 'document' as const, targetNodeId: 1, targetContainsHit: true, conversationRelation: 'unknown' as const, rootRelation: 'unknown' as const, scrollHeight: 3000, clientHeight: 800 };
      if (attempt === 1) {
        ack.onReceipt!({ ...base, before: 0, after: 700, written: true, eventObserved: false, frameObserved: false, state: 'invalidated', invalidatedReason: 'url' });
        throw new KydogError('browser.stale_snapshot', '页面在确认期间导航');
      }
      ack.onReceipt!({ ...base, before: 700, after: 1400, written: true, eventObserved: true, frameObserved: true, state: 'frame_observed', invalidatedReason: null });
      return { action, line: 'scrolled', navigation: null };
    });
    const row = (await searchX(input(), f.context)).queries[0];
    expect(row.posts).toHaveLength(6);
    expect(row.stopReason).toBe('cursor_exhausted');
    expect(row.status).toBe('observed');
    expect(row.diagnostics?.scroll).toMatchObject({ totalAttempts: 2, last: { state: 'frame_observed' } });
    expect(row.diagnostics?.scroll?.first).toMatchObject({ state: 'invalidated', invalidatedReason: 'url' });
  });

  it('allows one same-URL re-read per collection instead of once per query', async () => {
    const f = fixture([searchHtml('')]);
    const original = f.collect.getMockImplementation()!;
    let calls = 0;
    f.collect.mockImplementation(async (request) => {
      const n = calls++;
      // Same-URL generation change on load and again around the scroll.
      if (n === 0 || n === 2) {
        f.navigate();
        throw new KydogError('browser.stale_snapshot', '采集期间页面已导航');
      }
      const observed = await original(request);
      const page = decodeXSearchResponse(
        structuredClone(n >= 4 ? empty.body : captured.body),
        {
          provenance: { leaseId: 'lease', requestRef: 'request-' + n, navigationId: 'document', documentEpoch: 3, routeRevision: 7, navigationSequence: 9, operation: 'SearchTimeline', observedAt: '2026-10-15T00:00:00Z' },
          query, inputCursor: n > 1 ? 'cursor-' + (n - 1) : null,
        },
      );
      page.posts = page.posts.slice(0, 3).map((p, i) => ({ ...p, postId: String(2000 + n * 3 + i), sourceUrl: `https://x.com/CaptureAuthor/status/${2000 + n * 3 + i}` }));
      page.outputCursor = 'cursor-' + n;
      observed.network = { pages: [page], proof: page.provenance };
      observed.identityProven = true;
      return observed;
    });
    const row = (await searchX(input(), f.context)).queries[0];
    expect(row.posts).toHaveLength(6);
    expect(row.stopReason).toBe('cursor_exhausted');
    expect(row.collectionTransitions.filter((t) => t.outcome === 'same_url_generation_changed')).toHaveLength(2);
  });

  it('keeps the late page and only stops once the scroll itself stops moving', async () => {
    const f = harness();
    const collect = f.collect.getMockImplementation()!;
    let collects = 0, scrolls = 0;
    // Two batches arrive, then the list really ends.
    f.collect.mockImplementation(async (r) => {
      const observed = await collect(r);
      if (collects++ >= 2) observed.network = { pages: [], proof: observed.network!.proof };
      return observed;
    });
    f.act.mockImplementation(async (action, snapshot, opts) => {
      opts!.scrollAcknowledgement!.onWritten();
      const moved = ++scrolls <= 2;
      opts!.scrollAcknowledgement!.onReceipt!({
        generation: (snapshot as import('../browser/snapshot').AxSnapshot).generation,
        targetKind: 'document', targetNodeId: null, targetContainsHit: true,
        conversationRelation: 'unknown', rootRelation: 'unknown',
        // A geometric bottom from the first write on, as X's virtualized list gives.
        before: moved ? 0 : 10, after: 10, scrollHeight: 20, clientHeight: 10,
        written: true, eventObserved: true, frameObserved: true,
        state: moved ? 'frame_observed' : 'no_movement', invalidatedReason: null,
      } as never);
      return { action, line: 'scroll', navigation: null };
    });
    const row = (await searchX(input(), f.context)).queries[0];
    expect(row.posts).toHaveLength(6);
    expect(row.stopReason).toBe('explicit_ui_end');
    expect(row.diagnostics?.scroll?.last).toMatchObject({ after: 10, clientHeight: 10, scrollHeight: 20, written: true });
    expect(scrolls).toBe(4);
  });
  it('keeps scrolling toward the bottom instead of ending after one unanswered round', async () => {
    const f = harness();
    const collect = f.collect.getMockImplementation()!;
    // The reply is not there yet when the first bounded wait expires.
    f.page.wait = async () => false;
    let n = 0, scrolls = 0; const amounts: (number | undefined)[] = [];
    f.collect.mockImplementation(async (r) => {
      const observed = await collect(r);
      const i = n++;
      if (i !== 0 && i !== 2) observed.network = { pages: [], proof: observed.network!.proof };
      return observed;
    });
    f.act.mockImplementation(async (action, snapshot, opts) => {
      amounts.push((action as { amount?: number }).amount);
      opts!.scrollAcknowledgement!.onWritten();
      const moved = ++scrolls <= 3;
      opts!.scrollAcknowledgement!.onReceipt!({
        generation: (snapshot as import('../browser/snapshot').AxSnapshot).generation,
        targetKind: 'document', targetNodeId: null, targetContainsHit: true,
        conversationRelation: 'unknown', rootRelation: 'unknown',
        // Long page: one viewport is nowhere near the bottom.
        before: moved ? (scrolls - 1) * 10 : 30, after: moved ? scrolls * 10 : 30,
        scrollHeight: 100, clientHeight: 10,
        written: true, eventObserved: true, frameObserved: true,
        state: moved ? 'frame_observed' : 'no_movement', invalidatedReason: null,
      } as never);
      return { action, line: 'scroll', navigation: null };
    });
    const row = (await searchX(input(), f.context)).queries[0];
    // The batch that arrives after the second scroll is kept: one unanswered round
    // is not the end of the list.
    expect(row.posts).toHaveLength(6);
    expect(scrolls).toBeGreaterThanOrEqual(4);
    // The first round has no prior geometry; later rounds ask for the whole
    // remaining distance (scrollHeight 100 - clientHeight 10 - after 10) instead of
    // one viewport, so a 240k-px list does not need ~14 rounds per page.
    expect(amounts[0]).toBeUndefined();
    expect(amounts[1]).toBe(80);
  });

  it.each(['action', 'detach', 'cancel'] as const)(
    'retains accepted bodies on %s and never reports action_failed',
    async (kind) => {
      const f = harness();
      f.act.mockRejectedValueOnce(
        new KydogError(
          kind === 'cancel'
            ? 'browser.cancelled'
            : kind === 'detach'
              ? 'browser.not_dispatchable'
              : 'browser.target_unusable',
          'failure',
        ),
      );
      const row = (await searchX(input(), f.context)).queries[0];
      expect(row.posts).toHaveLength(3);
      expect(row.stopReason).toBe(
        kind === 'cancel' ? 'cancelled' : 'source_unavailable',
      );
    },
  );
  it('retains versions without counting duplicate identities toward the cap', async () => {
    const f = harness(3);
    const collect = f.collect.getMockImplementation()!;
    f.collect.mockImplementation(async (r) => {
      const o = await collect(r);
      for (const p of o.network!.pages[0].posts) {
        p.postId = '123';
        p.sourceUrl = 'https://x.com/CaptureAuthor/status/123';
      }
      return o;
    });
    const i = input();
    i.search.maxScrollsPerQuery = 2;
    const row = (await searchX(i, f.context)).queries[0];
    expect(row.posts).toHaveLength(1);
    expect(row.postObservations).toHaveLength(8);
    expect(row.budgetUsage.distinctEntries).toBe(1);
  });
  it('never accepts DOM text as search bodies and distinguishes timeout', async () => {
    const f = harness();
    expect(
      (
        await searchX(
          { ...input(), search: { ...input().search, maxScrollsPerQuery: 0 } },
          f.context,
        )
      ).queries[0].posts,
    ).toHaveLength(3);
    const dom = harness();
    const collect = dom.collect.getMockImplementation()!;
    dom.collect.mockImplementation(async (r) => {
      const o = await collect(r);
      o.posts = o.network!.pages[0].posts.map((p) => ({
        ...p,
        sourceKind: 'rendered_ui',
      }));
      delete o.network;
      return o;
    });
    dom.page.wait = async () => false;
    const row = (await searchX(input(), dom.context)).queries[0];
    expect(row.posts).toEqual([]);
    expect(row.stopReason).toBe('wait_timeout');
  });
});

it('preserves accepted source facts when queue cleanup rejects', async () => {
  const f = harness();
  const i = input();
  i.search.maxScrollsPerQuery = 0;
  f.context.browser.withPage = async (_tab, _signal, work) => {
    await work(f.page);
    throw new KydogError(
      'x.invalid_page',
      'source_unavailable:network_cleanup_failed',
    );
  };
  const row = (await searchX(i, f.context)).queries[0];
  expect(row.posts).toHaveLength(3);
  expect(row.collectionStop).toMatchObject({
    stopReason: 'source_unavailable',
    reason: 'source_unavailable:network_cleanup_failed',
  });
});

it('bounds multi-query network metadata delivery while canonical facts stay intact', async () => {
  const { serializeXResearchResult, xResearchToolResult } =
    await import('./xResearchOutput');
  const result = await searchX(
    { ...input(), search: { ...input().search, maxScrollsPerQuery: 0 } },
    harness().context,
  );
  const row = result.queries[0],
    provenance = row.posts[0].networkProvenance!;
  row.networkPages = Array.from({ length: 1000 }, (_, i) => ({
    provenance: { ...provenance, requestRef: String(i) },
    bytes: 1000,
    sha256: 'a'.repeat(64),
    inputCursorRef: 'c'.repeat(36),
    outputCursorRef: 'd'.repeat(36),
    end: 'unknown' as const,
    observed: 3,
    sampled: 3,
    omitted: 0,
    unsupported: [],
  }));
  result.queries = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(row),
    query: { ...query, id: 'q' + i },
  }));
  const output = serializeXResearchResult(result);
  expect(
    Buffer.byteLength(JSON.stringify(xResearchToolResult(output))),
  ).toBeLessThanOrEqual(1048576);
  expect(result.queries[0].networkPages).toHaveLength(1000);
  expect(output.result.delivery?.omittedFields).toContain(
    'queries.0.networkPages',
  );
});

it('maps a non-200 HTTP failure to a rate-limited barrier and labels the skipped queries', async () => {
  const f = harness();
  f.collect.mockRejectedValue(new KydogError('x.invalid_page', 'source_unavailable:http_status:429'));
  const two = parseXResearchInput({
    search: { objective: 'test', queries: [{ ...query, id: 'q1' }, { ...query, id: 'q2' }] },
  }) as Parameters<typeof searchX>[0];
  const result = await searchX(two, f.context);
  expect(result.queries[0]).toMatchObject({
    status: 'rate_limited', stopReason: 'access_barrier',
    barrier: { status: 'rate_limited', reason: 'http_status:429' },
  });
  // The skipped row must say why it never ran, not "agent_stopped".
  expect(result.queries[1]).toMatchObject({
    status: 'rate_limited', stopReason: 'access_barrier',
    barrier: { status: 'rate_limited', reason: 'not_attempted:rate_limited' },
  });
});

it.each([
  [429, 'rate_limited', 'access_barrier'],
  [503, 'rate_limited', 'access_barrier'],
  [403, 'access_denied', 'access_barrier'],
  [500, 'unavailable', 'source_unavailable'],
] as const)('preserves HTTP %s before and after accepted search evidence', async (code, status, stopReason) => {
  for (const accepted of [true, false]) {
    const f = harness();
    const collect = f.collect.getMockImplementation()!;
    f.collect.mockImplementation(async r => {
      if (!accepted) throw new KydogError('x.invalid_page', `source_unavailable:http_status:${code}`);
      const observed = await collect(r);
      observed.network!.failure = `http_status:${code}`;
      return observed;
    });
    const two = parseXResearchInput({ search: { objective: 'test', queries: [{ ...query, id: 'q1' }, { ...query, id: 'q2' }] } }) as Parameters<typeof searchX>[0];
    const rows = (await searchX(two, f.context)).queries;
    expect(rows[0]).toMatchObject({ status: accepted ? 'partial' : status, stopReason, barrier: { reason: `http_status:${code}` } });
    expect(rows[0].posts).toHaveLength(accepted ? 3 : 0);
    expect(rows[1]).toMatchObject({ status, stopReason, barrier: { reason: status === 'rate_limited' ? 'not_attempted:rate_limited' : `not_attempted:http_status:${code}` } });
    expect(f.open).toHaveBeenCalledTimes(1);
  }
});

it('labels queries skipped by an internal adapter stop instead of agent_stopped', async () => {
  const f = harness();
  f.collect.mockRejectedValue(new TypeError('broken adapter'));
  const two = parseXResearchInput({
    search: { objective: 'test', queries: [{ ...query, id: 'q1' }, { ...query, id: 'q2' }] },
  }) as Parameters<typeof searchX>[0];
  const result = await searchX(two, f.context);
  expect(result.queries[1]).toMatchObject({
    status: 'failed', stopReason: 'source_unavailable',
    barrier: { status: 'failed', reason: 'internal_adapter_stopped' },
  });
});

it('re-reads a canonical author-handle redirect for the same post and still rejects a real retarget', async () => {
  const at = (url: string, routeRevision: number) => ({
    currentUrl: url, documentEpoch: 1, routeRevision, navigationSequence: routeRevision * 2,
    navigationEvent: 'did-navigate' as const, navigationType: 'cross_document' as const, navigationUrl: null,
  });
  const canonical: import('./xResearchTypes').XCollectionTransition[] = [];
  let calls = 0;
  const page = {
    location: () => (calls === 0
      ? at('https://x.com/weiwang/status/2089854355331481872', 1)
      : at('https://x.com/wei_wang/status/2089854355331481872', 2)),
    collect: async () => {
      if (calls++ === 0) throw new KydogError('browser.stale_snapshot', 'site changed');
      return { snapshot: { url: 'https://x.com/wei_wang/status/2089854355331481872' } };
    },
  } as unknown as Parameters<typeof collectFreshXPage>[0];
  await collectFreshXPage(
    page,
    { stage: 'post', expectedUrl: 'https://x.com/weiwang/status/2089854355331481872', postId: '2089854355331481872' } as never,
    canonical,
  );
  expect(canonical[0]).toMatchObject({
    rereadRequested: true, relation: { origin: 'same', path: 'different', postId: 'same' },
  });
  // Control: a different post id is a genuine retarget and stays rejected.
  const retarget: import('./xResearchTypes').XCollectionTransition[] = [];
  let other = 0;
  const otherPage = {
    location: () => (other === 0
      ? at('https://x.com/alice/status/1000000000000000001', 1)
      : at('https://x.com/alice/status/1000000000000000002', 2)),
    collect: async () => { if (other++ === 0) throw new KydogError('browser.stale_snapshot', 'site changed'); return {}; },
  } as unknown as Parameters<typeof collectFreshXPage>[0];
  await expect(collectFreshXPage(
    otherPage,
    { stage: 'post', expectedUrl: 'https://x.com/alice/status/1000000000000000001', postId: '1000000000000000001' } as never,
    retarget,
  )).rejects.toThrow();
  expect(retarget[0]).toMatchObject({ rereadRequested: false, outcome: 'route_changed' });
});

it('binds the accepted-page safety budget independently of distinct IDs and scroll cap', async () => {
  const f = harness(1),
    collect = f.collect.getMockImplementation()!;
  f.collect.mockImplementation(async (r) => {
    const observed = await collect(r);
    for (const p of observed.network!.pages[0].posts) {
      p.postId = '123';
      p.sourceUrl = 'https://x.com/CaptureAuthor/status/123';
    }
    return observed;
  });
  const i = input();
  i.search.maxScrollsPerQuery = 1000;
  const row = (await searchX(i, f.context)).queries[0];
  expect(row.posts).toHaveLength(1);
  expect(row.postObservations).toHaveLength(999);
  expect(row.budgetUsage.scrolls).toBe(999);
  expect(row.budgetBinding).toEqual([
    { dimension: 'network_pages', limit: 1000, used: 1000, origin: 'safety' },
  ]);
  expect(row.stopReason).toBe('budget_reached');
});

it('retains historical accepted pages on generation invalidation and performs no further action',async()=>{
 const f=harness(),collect=f.collect.getMockImplementation()!;
 const positive=input();positive.search.maxScrollsPerQuery=1;await searchX(positive,f.context);expect(f.act).toHaveBeenCalledOnce();f.act.mockClear();
 f.collect.mockImplementation(async r=>{const o=await collect(r);o.network!.failure='generation_changed';o.identityProven=false;return o;});
 const row=(await searchX(input(),f.context)).queries[0];
 expect(row.posts).toHaveLength(3);expect(row.stopReason).toBe('source_unavailable');expect(row.barrier?.reason).toBe('generation_changed');expect(f.act).toHaveBeenCalledTimes(0);
});

it('preserves primary navigation/cancellation outcomes with canonical cleanup diagnostics',async()=>{
 const {retainXNetworkCleanupFailure}=await import('./xNetworkLease');const {canonicalizeXResearchResult}=await import('./xResearchCanonical');const {serializeXResearchResult}=await import('./xResearchOutput');
 const f=harness();
 f.context.browser.open=async()=>({tabId:'tab',evicted:[],nav:{navigationId:'nav',outcome:{kind:'timeout',abortObserved:false}},networkCleanupFailure:'network_cleanup_failed'});
 const failed=canonicalizeXResearchResult(await searchX(input(),f.context));
 if(failed.operation!=='search')throw Error('search');
 expect(failed.queries[0]).toMatchObject({stopReason:'navigation_failed',diagnostics:{networkCleanupFailure:'network_cleanup_failed'}});
 const cancelled=harness();cancelled.context.browser.withPage=async(_id,_signal,work)=>{await work(cancelled.page);const error=new KydogError('browser.cancelled','cancelled');retainXNetworkCleanupFailure(error);throw error;};
 const i=input();i.search.maxScrollsPerQuery=0;const output=serializeXResearchResult(await searchX(i,cancelled.context));
 expect(output.result.queries[0]).toMatchObject({status:'cancelled',stopReason:'cancelled',diagnostics:{networkCleanupFailure:'network_cleanup_failed'}});
 expect(output.result.queries[0].posts).toHaveLength(3);
});

it('binds accepted samples and pages synchronously even when cancellation wins the continuation', async () => {
  const run = async (cancel: boolean, pageCount: number, limit: number) => {
    const f = harness(3), i = input();
    i.search.maxPostsPerQuery = limit; i.search.maxScrollsPerQuery = 1000;
    f.context.budgetPolicy = { posts: {limit, origin: 'default'}, scrolls: {limit: 1000, origin: 'explicit'} };
    f.context.browser.withPage = async (_tab, _signal, work, hooks) => {
      const observed = await f.collect({stage:'search',expectedUrl:'https://x.com/search?q=from%3ACaptureAuthor&f=top',query:query.query,product:'Top'});
      for (let n = 0; n < pageCount; n++) {
        // Source-acceptance pressure: reuse decoded capture shape, vary exact
        // request and post identities, without constructing 1000 DOM fixtures.
        const source = structuredClone(observed.network!.pages[0]);
        source.provenance.requestRef = 'sink-' + n;
        source.posts = source.posts.map((post,index)=>({...post,postId:String(10000+3*n+index),sourceUrl:`https://x.com/CaptureAuthor/status/${10000+3*n+index}`,networkProvenance:source.provenance}));
        hooks!.onNetworkPageAccepted!(source, {provenance:source.provenance, bytes:1, sha256:'a'.repeat(64), inputCursorRef:null, outputCursorRef:null, end:source.end, unsupported:[], observed:3,sampled:3,omitted:0});
      }
      if (cancel) throw new KydogError('browser.cancelled', 'accepted then cancelled');
      return work(f.page);
    };
    return (await searchX(i, f.context)).queries[0];
  };
  const normal = await run(false, 1000, 2);
  const cancelled = await run(true, 1000, 2);
  const expected = [{dimension:'posts',limit:2,used:2,origin:'default'}, {dimension:'network_pages',limit:1000,used:1000,origin:'safety'}];
  expect(normal.budgetBinding).toEqual(expected);
  expect(normal.stopReason).toBe('budget_reached');
  expect(cancelled.budgetBinding).toEqual(expected);
  expect(cancelled.stopReason).toBe('cancelled');
  expect(cancelled.sampleTruncation).toEqual({observed:3000,sampled:2,omitted:2998});
  const below = await run(true, 1, 4);
  expect(below.posts).toHaveLength(3);
  expect(below.budgetBinding).toBeUndefined();
  expect(below.stopReason).toBe('cancelled');
});
