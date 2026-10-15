import { describe, it, expect } from 'vitest';
import captured from '../../test-support/fixtures/x-network/search-top-initial.json';
import empty from '../../test-support/fixtures/x-network/search-empty-initial.json';
import { fixture, searchHtml } from '../../test-support/xResearchFixture';
import { decodeXSearchResponse } from './xNetworkSource';
import { searchX } from './xResearchSearch';
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
  it('drains after exact geometric bottom receipt and retains the late page before stopping', async () => {
    const f = harness();
    f.act.mockImplementation(async (action, snapshot, opts) => {
      opts!.scrollAcknowledgement!.onWritten();
      opts!.scrollAcknowledgement!.onReceipt!({
        generation: (snapshot as import('../browser/snapshot').AxSnapshot)
          .generation,
        targetKind: 'document',
        targetNodeId: null,
        targetContainsHit: true,
        conversationRelation: 'unknown',
        rootRelation: 'unknown',
        before: 0,
        after: 10,
        scrollHeight: 20,
        clientHeight: 10,
        written: true,
        eventObserved: true,
        frameObserved: true,
        state: 'frame_observed',
      } as never);
      return { action, line: 'scroll', navigation: null };
    });
    const row = (await searchX(input(), f.context)).queries[0];
    expect(row.posts).toHaveLength(6);
    expect(row.stopReason).toBe('explicit_ui_end');
    expect(row.diagnostics?.scroll?.last).toMatchObject({
      after: 10,
      clientHeight: 10,
      scrollHeight: 20,
      written: true,
    });
    expect(f.collect).toHaveBeenCalledTimes(2);
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
