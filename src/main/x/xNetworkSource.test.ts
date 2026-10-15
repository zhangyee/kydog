import { describe, expect, it } from 'vitest';
import top from '../../test-support/fixtures/x-network/search-top-initial.json';
import topNext from '../../test-support/fixtures/x-network/search-top-next.json';
import latest from '../../test-support/fixtures/x-network/search-latest-initial.json';
import latestNext from '../../test-support/fixtures/x-network/search-latest-next.json';
import empty from '../../test-support/fixtures/x-network/search-empty-initial.json';
import {
  decodeXSearchResponse,
  type XSearchNetworkRequest,
} from './xNetworkSource';
const provenance = {
  leaseId: 'lease',
  requestRef: 'request',
  navigationId: 'document',
  documentEpoch: 2,
  routeRevision: 0,
  navigationSequence: 3,
  operation: 'SearchTimeline',
  observedAt: '2026-10-15T00:00:00Z',
};
const request = (f: {
  request: { rawQuery: string; product: string; cursor?: string };
}): XSearchNetworkRequest => ({
  provenance,
  query: {
    id: 'q',
    purpose: 'test',
    query: f.request.rawQuery,
    product: f.request.product as 'Top' | 'Latest',
  },
  inputCursor: 'cursor' in f.request ? String(f.request.cursor) : null,
});
describe('recorded SearchTimeline decoding', () => {
  it.each([
    [top, topNext],
    [latest, latestNext],
  ])('retains actual item/module order and exact pagination', (first, next) => {
    const a = decodeXSearchResponse(first.body, request(first));
    const b = decodeXSearchResponse(next.body, request(next));
    expect(a.posts.length).toBe(20);
    expect(b.posts.length).toBeGreaterThanOrEqual(20);
    expect(a.posts[0]).toMatchObject({
      sourceKind: 'page_graphql',
      author: { handle: 'CaptureAuthor' },
      networkProvenance: provenance,
    });
    expect(a.posts[0].postId).toMatch(/^900/);
    expect(a.posts[0].text).toMatch(/^Captured public text /);
    expect(a.outputCursor).toBe(next.request.cursor);
    expect(b.inputCursor).toBe(a.outputCursor);
    expect(a.end).toBe('unknown');
  });
  it('uses the recorded note text instead of the shorter legacy text', () => {
    const entries =
      latest.body.data.search_by_raw_query.search_timeline.timeline
        .instructions[0].entries!;
    const source = entries
      .flatMap((e) =>
        'itemContent' in e.content ? [e.content.itemContent] : [],
      )
      .find(
        (i) =>
          i && 'tweet_results' in i && 'note_tweet' in i.tweet_results.result,
      )!;
    const raw = (source as any).tweet_results.result;
    expect(
      decodeXSearchResponse(latest.body, request(latest)).posts.find(
        (p) => p.postId === raw.rest_id,
      )?.text,
    ).toBe(raw.note_tweet.note_tweet_results.result.text);
  });
  it('requires the recorded Bottom termination; an empty array or Top termination cannot prove end', () => {
    expect(decodeXSearchResponse(empty.body, request(empty)).end).toBe(
      'cursor_exhausted',
    );
    const changed = structuredClone(empty.body);
    changed.data.search_by_raw_query.search_timeline.timeline.instructions[1].direction =
      'Top';
    expect(decodeXSearchResponse(changed, request(empty)).end).toBe('unknown');
    changed.data.search_by_raw_query.search_timeline.timeline.instructions = [];
    expect(decodeXSearchResponse(changed, request(empty))).toMatchObject({
      end: 'unknown',
      unsupported: ['missing_pagination'],
    });
  });
  it('reports unknown instructions and GraphQL errors without manufacturing an empty result', () => {
    expect(decodeXSearchResponse(top.body, request(top)).posts.length).toBe(20);
    for (const body of [
      { errors: [{ message: 'private error' }] },
      {
        data: {
          search_by_raw_query: {
            search_timeline: {
              timeline: { instructions: [{ type: 'FutureInstruction' }] },
            },
          },
        },
      },
    ]) {
      const result = decodeXSearchResponse(body, request(top));
      expect(result.end).toBe('unknown');
      expect(result.unsupported.length).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain('private error');
    }
  });
});

it('canonical network bodies require validated provenance and exclusive search source', async () => {
  const { canonicalizeXResearchResult } = await import('./xResearchCanonical');
  const { searchResult } = await import('./xResearchSearch');
  const result = searchResult(
    {
      search: {
        objective: 'test',
        queries: [request(top).query],
        maxPostsPerQuery: 500,
        maxScrollsPerQuery: 0,
      },
    },
    { runId: 'run', callId: 'call', batchId: 'batch' } as never,
  );
  result.queries[0].posts = decodeXSearchResponse(top.body, request(top)).posts;
  const canonical = canonicalizeXResearchResult(result);
  if (canonical.operation !== 'search') throw new Error('search');
  expect(canonical.queries[0].posts[0]).toMatchObject({
    sourceKind: 'page_graphql',
    networkProvenance: provenance,
  });
  const bad = structuredClone(result);
  delete bad.queries[0].posts[0].networkProvenance;
  expect(() => canonicalizeXResearchResult(bad)).toThrow();
  bad.queries[0].posts[0].sourceKind = 'rendered_ui';
  expect(() => canonicalizeXResearchResult(bad)).toThrow();
});

it('preserves specific captured post identity and text in each recorded page', () => {
  for (const [fixture, id, text, size] of [
    [top, '9000000000000002', 'Captured public text 1', 20],
    [topNext, '90000000000000043', 'Captured public text 21', 23],
    [latest, '90000000000000092', 'Captured public text 44', 20],
    [latestNext, '900000000000000128', 'Captured public text 63', 20],
  ] as const) {
    const page = decodeXSearchResponse(fixture.body, request(fixture));
    expect(page.posts).toHaveLength(size);
    expect(page.posts[0]).toMatchObject({
      postId: id,
      text,
      author: { handle: 'CaptureAuthor', displayName: 'Capture Author' },
      sourceUrl: `https://x.com/CaptureAuthor/status/${id}`,
    });
  }
});
