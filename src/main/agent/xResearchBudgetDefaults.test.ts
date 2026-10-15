import { describe, expect, it } from 'vitest';
import { fixture, post, query, readHtml, searchHtml, stagedFixture } from '../../test-support/xResearchFixture';
import { createXResearchTool } from './xResearchTool';

const target = { url: 'https://x.com/alice/status/123' };

// The DOM boundary is offline; parser, collector, orchestration and final SDK envelope are real.
function toolFor(f: { context: ReturnType<typeof fixture>['context'] }) {
  return createXResearchTool({ browser: f.context.browser, threadId: 'thread', sources: f.context.sources, currentRunId: () => 'budget-run' });
}
function bodies(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => post(String(start + i), 'bob', `body-${start + i}`)).join('');
}

describe('ordinary research budgets through the SDK entry point', () => {
  // Catch the old 20-scroll/100-body default and overrides that silently raise an explicit cap.
  it.each([3, 7])('search reaches 500 bodies beyond twenty scrolls, stopping each supplied dimension (%i bodies/frame)', async count => {
    const pages = Array.from({ length: 168 }, (_, i) => searchHtml(bodies(1000 + i * count, count)));
    const run = async (caps: { maxPostsPerQuery?: number; maxScrollsPerQuery?: number }) => {
      const f = fixture(pages);
      const result = await toolFor(f).execute('search-budget', { search: { objective: 'research', queries: [query], ...caps } }, undefined, undefined, {} as never);
      if (result.details?.operation !== 'search') throw new Error('search result expected');
      const row = result.details.queries[0];
      expect(row).toMatchObject({ status: 'partial', stopReason: 'budget_reached' });
      expect(result.details.budgetUsage.scrolls).toBe(row.budgetUsage.scrolls);
      expect(result.details.budgetUsage.distinctEntries).toBe(row.posts.length);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.details);
      expect(Buffer.byteLength(JSON.stringify(result))).toBe(result.details.budgetUsage.outputBytes);
      expect(result.details.budgetUsage.outputBytes).toBeLessThanOrEqual(1024 * 1024);
      return { f, row };
    };
    const ordinary = await run({});
    expect(ordinary.row.posts.length).toBe(500);
    expect(ordinary.row.budgetUsage.scrolls).toBe(Math.ceil(500 / count) - 1);
    expect(ordinary.f.act).toHaveBeenCalledTimes(Math.ceil(500 / count) - 1);
    expect(ordinary.row.posts).toContainEqual(expect.objectContaining({ postId: '1030', text: 'body-1030' }));
    expect(ordinary.f.context.sources.get('1030')).toContainEqual(expect.objectContaining({ sourceUrl: 'https://x.com/bob/status/1030', queryId: 'q2' }));
    const six = await run({ maxScrollsPerQuery: 6 });
    expect(six.f.act).toHaveBeenCalledTimes(6);
    expect(six.row.budgetUsage.scrolls).toBe(6);
    expect(six.row.posts).toHaveLength(7 * count);
    const thirty = await run({ maxPostsPerQuery: 30 });
    expect(thirty.row.posts).toHaveLength(30);
    expect(thirty.row.posts.at(-1)?.postId).toBe('1029');
    expect(thirty.row.posts.map(p => p.postId)).not.toContain('1030');
    const zero = await run({ maxScrollsPerQuery: 0 });
    expect(zero.f.act).toHaveBeenCalledTimes(0);
    expect(zero.row.posts).toHaveLength(count);
  }, 30000);

  // Moving the root behind the replies prevents fixture order from proving the wrong identity.
  it.each([false, true])('read continues beyond old limits with exact source identity and unknown scope (rootLast=%s)', async rootLast => {
    for (const count of [3, 7]) {
      const pages = Array.from({ length: 168 }, (_, i) => {
        const root = post('123', 'alice', 'focal body');
        const replies = bodies(1000 + i * count, count);
        return readHtml(rootLast ? replies + root : root + replies);
      });
      const run = async (caps: { maxRepliesPerPost?: number; maxScrollsPerPost?: number }) => {
        const f = fixture(pages);
        const result = await toolFor(f).execute('read-budget', { tabId: 'research-tab', read: { objective: 'read', targets: [target], includeArticle: false, ...caps } }, undefined, undefined, {} as never);
        if (result.details?.operation !== 'read') throw new Error('read result expected');
        const row = result.details.targets[0];
        expect(row).toMatchObject({ root: { postId: '123', sourceUrl: target.url, text: 'focal body' }, status: 'partial', stopReason: 'budget_reached', replies: { requested: true, scope: { completeness: 'unknown' } } });
        expect(result.details.budgetUsage.scrolls).toBe(row.budgetUsage.scrolls);
        expect(result.details.budgetUsage.distinctEntries).toBe(1 + row.replies.observations.length);
        expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(result.details);
        expect(Buffer.byteLength(JSON.stringify(result))).toBe(result.details.budgetUsage.outputBytes);
        expect(result.details.budgetUsage.outputBytes).toBeLessThanOrEqual(1024 * 1024);
        return { f, row };
      };
      const ordinary = await run({});
      expect(ordinary.row.replies.observations).toHaveLength(500);
      expect(ordinary.f.act).toHaveBeenCalledTimes(Math.ceil(500 / count) - 1);
      expect(ordinary.row.budgetUsage.scrolls).toBe(Math.ceil(500 / count) - 1);
      expect(ordinary.row.replies.observations).toContainEqual(expect.objectContaining({ postId: '1030', sourceUrl: 'https://x.com/bob/status/1030', text: 'body-1030' }));
      const six = await run({ maxScrollsPerPost: 6 });
      expect(six.f.act).toHaveBeenCalledTimes(6);
      expect(six.row.budgetUsage.scrolls).toBe(6);
      expect(six.row.replies.observations).toHaveLength(7 * count);
      const thirty = await run({ maxRepliesPerPost: 30 });
      expect(thirty.row.replies.observations).toHaveLength(30);
      expect(thirty.row.replies.observations.at(-1)?.postId).toBe('1029');
      expect(thirty.row.replies.observations.map(p => p.postId)).not.toContain('1030');
      const seven = await run({ maxRepliesPerPost: 7 });
      expect(seven.row.replies.observations).toHaveLength(7);
      expect(seven.row.budgetBinding).toContainEqual({ dimension: 'replies', limit: 7, origin: 'explicit', used: 7 });
      const zero = await run({ maxScrollsPerPost: 0 });
      expect(zero.f.act).toHaveBeenCalledTimes(0);
      expect(zero.row.replies.observations).toHaveLength(count);
    }
  }, 30000);

  it('uses five hundred expansion actions by default and honors an explicit six or zero before the next action', async () => {
    const pages = Array.from({ length: 501 }, (_, i) => readHtml(post() + post(String(1000 + i), 'bob', `body-${i}`) + '<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>'));
    const run = async (maxExpandActionsPerPost?: number) => {
      const f = fixture(pages);
      const result = await toolFor(f).execute('expand-budget', { tabId: 'research-tab', read: { objective: 'expand', targets: [target], includeArticle: false, maxRepliesPerPost: 1000, ...(maxExpandActionsPerPost === undefined ? {} : { maxExpandActionsPerPost }) } }, undefined, undefined, {} as never);
      if (result.details?.operation !== 'read') throw new Error('read result expected');
      const row = result.details.targets[0];
      expect(row).toMatchObject({ status: 'partial', stopReason: 'budget_reached', budgetUsage: { scrolls: 0 }, replies: { scope: { completeness: 'unknown' } } });
      return { f, row };
    };
    const ordinary = await run();
    expect(ordinary.row.budgetUsage.expandActions).toBe(500);
    expect(ordinary.row.replies.observations).toHaveLength(501);
    expect(ordinary.f.act.mock.calls.map(c => c[0].kind)).toEqual(Array(500).fill('click'));
    const six = await run(6);
    expect(six.row.budgetUsage.expandActions).toBe(6);
    expect(six.row.replies.observations).toHaveLength(7);
    expect(six.f.act).toHaveBeenCalledTimes(6);
    const zero = await run(0);
    expect(zero.row.replies.observations).toHaveLength(1);
    expect(zero.row.budgetUsage.expandActions).toBe(0);
    expect(zero.f.act).toHaveBeenCalledTimes(0);
  }, 30000);
});

// These fixtures test DOM resource orchestration, never network protocol identity.
describe('zero and sampling boundaries through the SDK', () => {
  it('posts zero prevents navigation and collection after a nonzero control', async () => {
    const f = fixture([searchHtml(bodies(1, 3))]);
    const run = (maxPostsPerQuery: number) => toolFor(f).execute('zero', { search: { objective: 'test', queries: [query], maxPostsPerQuery, maxScrollsPerQuery: 7 } }, undefined, undefined, {} as never);
    await run(1);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.collect).toHaveBeenCalledTimes(1);
    f.open.mockClear(); f.collect.mockClear();
    const result = await run(0);
    expect(f.open).toHaveBeenCalledTimes(0);
    expect(f.collect).toHaveBeenCalledTimes(0);
    if (result.details?.operation !== 'search') throw new Error('search expected');
    expect(result.details.queries[0]).toMatchObject({ budgetBinding: [{ dimension: 'posts', limit: 0, origin: 'explicit', used: 0 }], collectionStop: { status: 'partial', stopReason: 'budget_reached', reason: null } });
  });
  it('reports omitted bodies separately from collection stop and explicit caps independently', async () => {
    const f = fixture(Array.from({ length: 167 }, (_, i) => searchHtml(bodies(1 + i * 3, 3))));
    const result = await toolFor(f).execute('sample', { search: { objective: 'test', queries: [query] } }, undefined, undefined, {} as never);
    if (result.details?.operation !== 'search') throw new Error('search expected');
    expect(result.details.queries[0]).toMatchObject({ posts: expect.any(Array), sampleTruncation: { observed: 501, sampled: 500, omitted: 1 }, budgetBinding: [{ dimension: 'posts', limit: 500, origin: 'default', used: 500 }], collectionStop: { status: 'partial', stopReason: 'budget_reached', reason: null } });
    expect(result.details.queries[0].posts).toHaveLength(500);
    const small = await toolFor(fixture([searchHtml(bodies(1, 10))])).execute('small', { search: { objective: 'test', queries: [query], maxPostsPerQuery: 7, maxScrollsPerQuery: 0 } }, undefined, undefined, {} as never);
    if (small.details?.operation !== 'search') throw new Error('search expected');
    expect(small.details.queries[0]).toMatchObject({ budgetBinding: [{ dimension: 'posts', limit: 7, origin: 'explicit', used: 7 }, { dimension: 'scrolls', limit: 0, origin: 'explicit', used: 0 }] });
    expect(small.details.queries[0].posts).toHaveLength(7);
  });
  it('replies zero retains root and expansion zero blocks body, Article and reply clicks', async () => {
    const run = async (expands: number, replies: number) => {
      const f = await stagedFixture({ article: 'reject' });
      const result = await toolFor(f).execute('read-zero', { tabId: 'research-tab', read: { objective: 'test', targets: [target], maxRepliesPerPost: replies, maxScrollsPerPost: 0, maxExpandActionsPerPost: expands } }, undefined, undefined, {} as never);
      if (result.details?.operation !== 'read') throw new Error('read expected');
      return { f, row: result.details.targets[0] };
    };
    const positive = await run(3, 3);
    expect(positive.f.executed).toContain('body_expand');
    expect(positive.f.executed).toContain('replies_expand');
    expect(positive.row.article.actionAttempted).toBe(true);
    expect(positive.row.replies.observations.length).toBeGreaterThan(0);
    const zero = await run(0, 0);
    expect(zero.row.root?.postId).toBe('123');
    expect(zero.row.replies.observations).toHaveLength(0);
    expect(zero.f.executed).toHaveLength(0);
    expect(zero.row.article.actionAttempted).toBe(false);
    expect(zero.row.budgetBinding).toContainEqual({ dimension: 'replies', limit: 0, origin: 'explicit', used: 0 });
  });
});
