import { describe, expect, it } from 'vitest';
import { fixture, post, query, readHtml, searchHtml } from '../../test-support/xResearchFixture';
import { createXResearchTool } from './xResearchTool';

const target = { url: 'https://x.com/alice/status/123' };

// The DOM boundary is offline; parser, collector, orchestration and final SDK envelope are real.
function toolFor(f: ReturnType<typeof fixture>) {
  return createXResearchTool({ browser: f.context.browser, threadId: 'thread', sources: f.context.sources, currentRunId: () => 'budget-run' });
}
function bodies(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => post(String(start + i), 'bob', `body-${start + i}`)).join('');
}

describe('ordinary research budgets through the SDK entry point', () => {
  // Catch the old 6-scroll/30-body default and overrides that silently raise an explicit cap.
  it.each([3, 7])('search continues beyond six scrolls and thirty posts, stopping each supplied dimension (%i bodies/frame)', async count => {
    const pages = Array.from({ length: 22 }, (_, i) => searchHtml(bodies(1000 + i * count, count)));
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
    expect(ordinary.row.posts.length).toBe(count === 3 ? 63 : 100);
    expect(ordinary.row.budgetUsage.scrolls).toBe(count === 3 ? 20 : 14);
    expect(ordinary.f.act).toHaveBeenCalledTimes(count === 3 ? 20 : 14);
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
  });

  // Moving the root behind the replies prevents fixture order from proving the wrong identity.
  it.each([false, true])('read continues beyond old limits with exact source identity and unknown scope (rootLast=%s)', async rootLast => {
    for (const count of [3, 7]) {
      const pages = Array.from({ length: 22 }, (_, i) => {
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
      expect(ordinary.row.replies.observations).toHaveLength(count === 3 ? 63 : 100);
      expect(ordinary.f.act).toHaveBeenCalledTimes(count === 3 ? 20 : 14);
      expect(ordinary.row.budgetUsage.scrolls).toBe(count === 3 ? 20 : 14);
      expect(ordinary.row.replies.observations).toContainEqual(expect.objectContaining({ postId: '1030', sourceUrl: 'https://x.com/bob/status/1030', text: 'body-1030' }));
      const six = await run({ maxScrollsPerPost: 6 });
      expect(six.f.act).toHaveBeenCalledTimes(6);
      expect(six.row.budgetUsage.scrolls).toBe(6);
      expect(six.row.replies.observations).toHaveLength(7 * count);
      const thirty = await run({ maxRepliesPerPost: 30 });
      expect(thirty.row.replies.observations).toHaveLength(30);
      expect(thirty.row.replies.observations.at(-1)?.postId).toBe('1029');
      expect(thirty.row.replies.observations.map(p => p.postId)).not.toContain('1030');
      const zero = await run({ maxScrollsPerPost: 0 });
      expect(zero.f.act).toHaveBeenCalledTimes(0);
      expect(zero.row.replies.observations).toHaveLength(count);
    }
  });

  it('uses twenty expansion actions by default and honors an explicit six or zero before the next action', async () => {
    const pages = Array.from({ length: 22 }, (_, i) => readHtml(post() + bodies(1000, i + 1) + '<div data-testid="cellInnerDiv"><button role="button" type="button">Show replies</button></div>'));
    const run = async (maxExpandActionsPerPost?: number) => {
      const f = fixture(pages);
      const result = await toolFor(f).execute('expand-budget', { tabId: 'research-tab', read: { objective: 'expand', targets: [target], includeArticle: false, ...(maxExpandActionsPerPost === undefined ? {} : { maxExpandActionsPerPost }) } }, undefined, undefined, {} as never);
      if (result.details?.operation !== 'read') throw new Error('read result expected');
      const row = result.details.targets[0];
      expect(row).toMatchObject({ status: 'partial', stopReason: 'budget_reached', budgetUsage: { scrolls: 0 }, replies: { scope: { completeness: 'unknown' } } });
      return { f, row };
    };
    const ordinary = await run();
    expect(ordinary.row.budgetUsage.expandActions).toBe(20);
    expect(ordinary.row.replies.observations).toHaveLength(21);
    expect(ordinary.f.act.mock.calls.map(c => c[0].kind)).toEqual(Array(20).fill('click'));
    const six = await run(6);
    expect(six.row.budgetUsage.expandActions).toBe(6);
    expect(six.row.replies.observations).toHaveLength(7);
    expect(six.f.act).toHaveBeenCalledTimes(6);
    const zero = await run(0);
    expect(zero.row.replies.observations).toHaveLength(1);
    expect(zero.row.budgetUsage.expandActions).toBe(0);
    expect(zero.f.act).toHaveBeenCalledTimes(0);
  });
});
