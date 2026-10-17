// 预算默认值与显式上限：从**动作面**（`submit` → 队列 → runner → 采集层 → `wait` 交付）走一遍。
// 旧的非动作式工具删掉之后，`origin: 'default' | 'explicit'` 这两个标签唯一的产地仍是
// `xResearchBudget.resolveXBudgetPolicy` —— 它看的是「这个键写没写」，而原始参数只在工具那一层
// （R19）。所以这份用例守的是整条链路：标签与数字都不许在搬运中丢。
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import { fixture, post, query, readHtml, searchHtml, stagedFixture } from '../../test-support/xResearchFixture';
import { createXResearchRunner } from './xResearchRunner';
import { XResearchScopeLedger } from './xResearchScopeFacts';
import { XResearchTaskService } from './xResearchTaskService';
import { XResearchTaskStore } from './xResearchTaskStore';
import type { XResearchDeliveryEnvelope } from './xResearchTaskShell';
import type { XResearchResult } from './xResearchTypes';
import { createXResearchTools } from '../agent/xResearchTools';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'x-budget-'));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const target = { url: 'https://x.com/alice/status/123' };

type FixtureContext = ReturnType<typeof fixture>['context'];

/** 一次提交的完整往返：`submit` 排队，`wait` 交付。产出的就是模型看到的那一份结果。 */
function toolFor(f: { context: FixtureContext }) {
  const threadId = randomUUID();
  const ledger = new XResearchScopeLedger();
  const service = new XResearchTaskService({
    store: new XResearchTaskStore(root()),
    runWork: createXResearchRunner({
      browserFor: () => f.context.browser,
      contextFor: () => ({
        sources: f.context.sources,
        scopePrior: (runId) => ledger.prior(runId),
        currentRunId: () => 'budget-run',
      }),
      artifacts: () => tempXArtifactStore(),
    }),
    onUpdate: () => undefined,
    artifacts: () => tempXArtifactStore(),
  });
  const tool = createXResearchTools({
    service, threadId, projectRoot: '/projects/x', currentRunId: () => 'budget-run',
    observeDelivery: () => undefined,
  });
  return async (args: Record<string, unknown>): Promise<{
    result: XResearchResult; envelope: XResearchDeliveryEnvelope;
  }> => {
    const submitted = (await tool.execute('submit-budget', { action: 'submit', ...args } as never,
      undefined, undefined, {} as never)).details as XResearchDeliveryEnvelope;
    const delivered = (await tool.execute('wait-budget', {
      action: 'wait', researchRunId: submitted.researchRunId,
    } as never, undefined, undefined, {} as never)).details as XResearchDeliveryEnvelope;
    if (!delivered.delivery) throw new Error('expected a delivered result');
    // 交付副本自己写着它在模型眼里占多少字节（壳 + 快照 + 结果，spec §4.5）：定点由
    // `deliverEnvelope` 量出来并盖在这里，所以它必须是一个真的、装得进包络的数。
    expect(delivered.delivery.result.budgetUsage.outputBytes).toBeGreaterThan(0);
    expect(delivered.delivery.result.budgetUsage.outputBytes).toBeLessThanOrEqual(1024 * 1024);
    return { result: delivered.delivery.result, envelope: delivered };
  };
}

function bodies(start: number, count: number) {
  return Array.from({ length: count }, (_, i) => post(String(start + i), 'bob', `body-${start + i}`)).join('');
}

describe('ordinary research budgets through the submit path', () => {
  // Catch the old 20-scroll/100-body default and overrides that silently raise an explicit cap.
  it.each([3, 7])('search reaches 500 bodies beyond twenty scrolls, stopping each supplied dimension (%i bodies/frame)', async count => {
    const pages = Array.from({ length: 168 }, (_, i) => searchHtml(bodies(1000 + i * count, count)));
    const run = async (caps: { maxPostsPerQuery?: number; maxScrollsPerQuery?: number }) => {
      const f = fixture(pages);
      const { result } = await toolFor(f)({ search: { objective: 'research', queries: [query], ...caps } });
      if (result.operation !== 'search') throw new Error('search result expected');
      const row = result.queries[0];
      expect(row).toMatchObject({ status: 'partial', stopReason: 'budget_reached' });
      expect(result.budgetUsage.scrolls).toBe(row.budgetUsage.scrolls);
      expect(result.budgetUsage.distinctEntries).toBe(row.posts.length);
      return { f, row };
    };
    const ordinary = await run({});
    expect(ordinary.row.posts.length).toBe(500);
    expect(ordinary.row.budgetUsage.scrolls).toBe(Math.ceil(500 / count) - 1);
    expect(ordinary.f.act).toHaveBeenCalledTimes(Math.ceil(500 / count) - 1);
    // 「省缺 = 500」这件事必须由**默认**这两个字说出来，而不是一个恰好为 500 的数字。
    expect(ordinary.row.budgetBinding).toEqual([
      { dimension: 'posts', limit: 500, origin: 'default', used: 500 },
    ]);
    expect(ordinary.row.posts).toContainEqual(expect.objectContaining({ postId: '1030', text: 'body-1030' }));
    const six = await run({ maxScrollsPerQuery: 6 });
    expect(six.f.act).toHaveBeenCalledTimes(6);
    expect(six.row.budgetUsage.scrolls).toBe(6);
    expect(six.row.budgetBinding).toContainEqual({ dimension: 'scrolls', limit: 6, origin: 'explicit', used: 6 });
    const thirty = await run({ maxPostsPerQuery: 30 });
    expect(thirty.row.posts).toHaveLength(30);
    expect(thirty.row.posts.at(-1)?.postId).toBe('1029');
    expect(thirty.row.posts.map(p => p.postId)).not.toContain('1030');
    expect(thirty.row.budgetBinding).toEqual([
      { dimension: 'posts', limit: 30, origin: 'explicit', used: 30 },
    ]);
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
        const { result } = await toolFor(f)({ read: { objective: 'read', targets: [target], includeArticle: false, ...caps } });
        if (result.operation !== 'read') throw new Error('read result expected');
        const row = result.targets[0];
        expect(row).toMatchObject({
          root: { postId: '123', sourceUrl: target.url, text: 'focal body' },
          status: 'partial', stopReason: 'budget_reached',
          replies: { requested: true, scope: { kind: 'network', extent: 'unknown' } },
        });
        expect(result.budgetUsage.scrolls).toBe(row.budgetUsage.scrolls);
        expect(result.budgetUsage.distinctEntries).toBe(1 + row.replies.observations.length);
        return { f, row };
      };
      const ordinary = await run({});
      expect(ordinary.row.replies.observations).toHaveLength(500);
      expect(ordinary.f.act).toHaveBeenCalledTimes(Math.ceil(500 / count) - 1);
      expect(ordinary.row.budgetUsage.scrolls).toBe(Math.ceil(500 / count) - 1);
      // 回复维度的默认值也走同一条标签：省缺 → default，写死 7 → explicit。
      expect(ordinary.row.budgetBinding).toEqual([
        { dimension: 'replies', limit: 500, origin: 'default', used: 500 },
      ]);
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
      const { result } = await toolFor(f)({
        read: {
          objective: 'expand', targets: [target], includeArticle: false, maxRepliesPerPost: 1000,
          ...(maxExpandActionsPerPost === undefined ? {} : { maxExpandActionsPerPost }),
        },
      });
      if (result.operation !== 'read') throw new Error('read result expected');
      const row = result.targets[0];
      expect(row).toMatchObject({ status: 'partial', stopReason: 'budget_reached', budgetUsage: { scrolls: 0 }, replies: { scope: { kind: 'network', extent: 'unknown' } } });
      return { f, row };
    };
    const ordinary = await run();
    expect(ordinary.row.budgetUsage.expandActions).toBe(500);
    expect(ordinary.row.replies.observations).toHaveLength(501);
    expect(ordinary.row.budgetBinding).toEqual([
      { dimension: 'expands', limit: 500, origin: 'default', used: 500 },
    ]);
    expect(ordinary.f.act.mock.calls.map(c => c[0].kind)).toEqual(Array(500).fill('click'));
    const six = await run(6);
    expect(six.row.budgetUsage.expandActions).toBe(6);
    expect(six.row.replies.observations).toHaveLength(7);
    expect(six.f.act).toHaveBeenCalledTimes(6);
    expect(six.row.budgetBinding).toContainEqual({ dimension: 'expands', limit: 6, origin: 'explicit', used: 6 });
    const zero = await run(0);
    expect(zero.row.replies.observations).toHaveLength(1);
    expect(zero.row.budgetUsage.expandActions).toBe(0);
    expect(zero.f.act).toHaveBeenCalledTimes(0);
    expect(zero.row.budgetBinding).toContainEqual({ dimension: 'expands', limit: 0, origin: 'explicit', used: 0 });
  }, 30000);
});

// These fixtures test DOM resource orchestration, never network protocol identity.
describe('zero and sampling boundaries through the submit path', () => {
  it('posts zero prevents navigation and collection after a nonzero control', async () => {
    const f = fixture([searchHtml(bodies(1, 3))]);
    const run = (maxPostsPerQuery: number) => toolFor(f)({ search: { objective: 'test', queries: [query], maxPostsPerQuery, maxScrollsPerQuery: 7 } });
    const control = await run(1);
    if (control.result.operation !== 'search') throw new Error('search expected');
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.collect).toHaveBeenCalledTimes(1);
    f.open.mockClear(); f.collect.mockClear();
    const zero = await run(0);
    if (zero.result.operation !== 'search') throw new Error('search expected');
    // 零帖子 = 一次导航都不该发生，但「没导航」这件事本身照样是一条结论。
    expect(f.open).toHaveBeenCalledTimes(0);
    expect(f.collect).toHaveBeenCalledTimes(0);
    expect(zero.result.queries[0]).toMatchObject({
      budgetBinding: [{ dimension: 'posts', limit: 0, origin: 'explicit', used: 0 }],
      collectionStop: { status: 'partial', stopReason: 'budget_reached', reason: null },
    });
  });

  it('reports omitted bodies separately from collection stop and explicit caps independently', async () => {
    const f = fixture(Array.from({ length: 167 }, (_, i) => searchHtml(bodies(1 + i * 3, 3))));
    const sampled = await toolFor(f)({ search: { objective: 'test', queries: [query] } });
    if (sampled.result.operation !== 'search') throw new Error('search expected');
    expect(sampled.result.queries[0]).toMatchObject({
      posts: expect.any(Array),
      sampleTruncation: { observed: 501, sampled: 500, omitted: 1 },
      budgetBinding: [{ dimension: 'posts', limit: 500, origin: 'default', used: 500 }],
      collectionStop: { status: 'partial', stopReason: 'budget_reached', reason: null },
    });
    expect(sampled.result.queries[0].posts).toHaveLength(500);
    const small = await toolFor(fixture([searchHtml(bodies(1, 10))]))({
      search: { objective: 'test', queries: [query], maxPostsPerQuery: 7, maxScrollsPerQuery: 0 },
    });
    if (small.result.operation !== 'search') throw new Error('search expected');
    expect(small.result.queries[0]).toMatchObject({
      budgetBinding: [
        { dimension: 'posts', limit: 7, origin: 'explicit', used: 7 },
        { dimension: 'scrolls', limit: 0, origin: 'explicit', used: 0 },
      ],
    });
    expect(small.result.queries[0].posts).toHaveLength(7);
  });

  it('replies zero retains network root and expansion zero blocks Article and reply clicks', async () => {
    const run = async (expands: number, replies: number) => {
      const f = await stagedFixture({ article: 'reject' });
      const { result } = await toolFor(f)({
        read: {
          objective: 'test', targets: [target], maxRepliesPerPost: replies,
          maxScrollsPerPost: 0, maxExpandActionsPerPost: expands,
        },
      });
      if (result.operation !== 'read') throw new Error('read expected');
      return { f, row: result.targets[0] };
    };
    const positive = await run(3, 3);
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

it('reply zero reaches initial and Article-return producers while nonzero expansion still reads root and Article', async () => {
  const run = async (maxRepliesPerPost: number) => {
    const f = await stagedFixture({ article: 'ok' });
    const frames: { request: import('./xObservation').XPageRequest; replies: number }[] = [];
    const withPage = f.context.browser.withPage.bind(f.context.browser);
    f.context.browser.withPage = (tabId, signal, work, options) => withPage(tabId, signal, page => {
      const proxied: typeof page = {
        ...page, collect: async request => {
          const frame = await page.collect(request);
          frames.push({
            request,
            replies: frame.network?.pages.reduce((n, p) => n + (
              'replies' in p ? (p as import('./xNetworkSource').XNetworkReadPage).replies.length : 0), 0) ?? 0,
          });
          return frame;
        },
      };
      return work(proxied);
    }, options);
    const { result } = await toolFor(f)({
      read: {
        objective: 'independent scopes', targets: [target], includeArticle: true, includeReplies: true,
        maxRepliesPerPost, maxScrollsPerPost: 0, maxExpandActionsPerPost: 4,
      },
    });
    if (result.operation !== 'read') throw new Error('read expected');
    return { f, frames: frames.filter(frame => frame.request.stage === 'post'), row: result.targets[0] };
  };
  const positive = await run(2);
  expect(positive.f.executed).toEqual(['article_entry', 'replies_expand']);
  expect(positive.frames.some(frame => frame.replies > 0)).toBe(true);
  expect(positive.row.replies.observations).toHaveLength(2);
  expect(positive.row.sampleTruncation!.observed).toBeGreaterThan(0);
  expect(positive.f.context.sources.get('789')).toBeDefined();
  const zero = await run(0);
  expect(zero.f.executed).toEqual(['article_entry']);
  expect(zero.f.context.sources.get('789')).toBeUndefined();
  expect(zero.f.opens).toEqual([target.url, target.url]);
  expect(zero.frames.length).toBeGreaterThanOrEqual(2);
  expect(zero.frames.map(frame => ({ collectReplies: 'collectReplies' in frame.request ? frame.request.collectReplies : undefined, replies: frame.replies }))).toEqual(Array(zero.frames.length).fill({ collectReplies: false, replies: 0 }));
  expect(zero.row).toMatchObject({
    root: { postId: '123', text: 'preview' },
    article: { bodyObserved: true, body: { text: 'Article paragraph\n\nHeading' } },
    replies: { observations: [] },
    sampleTruncation: { observed: 0, sampled: 0, omitted: 0 },
    budgetUsage: { expandActions: 1, scrolls: 0 },
  });
});
