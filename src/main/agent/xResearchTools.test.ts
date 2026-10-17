// `x_research` 动作面的用例：真 service + 假工作体。
//
// 队列、落盘、交付都是真的（`XResearchTaskStore` 落在临时目录里），只有「跑一次提交」换成假工作体。
// 这样这里量的是动作面本身：它把什么交给服务、把什么交回模型、证据账本（`observeDelivery`）被喂了几次。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import { logger } from '../log';
import type { XBudgetPolicy } from '../x/xResearchBudget';
import type { XResearchDeliveryEnvelope } from '../x/xResearchTaskShell';
import { XResearchTaskService, type XResearchRunWork } from '../x/xResearchTaskService';
import { XResearchTaskStore } from '../x/xResearchTaskStore';
import type { XResearchResult, XSearchObservation, XSearchQuery } from '../x/xResearchTypes';
import { createXResearchTools } from './xResearchTools';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xtools-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  // 一个断言失败时漏出去的 spy 会污染后面的用例。
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 用例决定何时放行的闸门：把「这一轮还在飞」钉成事实，不靠 sleep。 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

const queries: XSearchQuery[] = [
  { id: 'q1', query: 'Qwen3.8 27B', purpose: '看实际表现', product: 'Top' },
  { id: 'q2', query: 'Qwen3.8 27B Q4', purpose: '看量化版', product: 'Latest' },
];
const searchArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  objective: 'Qwen3.8 27B 量化版在 agentic 任务上的表现',
  queries: [queries[0]],
  ...over,
});
const readArgs = (): Record<string, unknown> => ({
  objective: '读这条帖子的正文与回复',
  targets: [{ postId: '19581' }],
});

const usage = (over: Partial<XSearchObservation['budgetUsage']> = {}): XSearchObservation['budgetUsage'] =>
  ({ scrolls: 0, expandActions: 0, distinctEntries: 0, outputBytes: 0, ...over });

function searchRow(over: Partial<XSearchObservation> = {}): XSearchObservation {
  return {
    query: queries[0],
    collectionTransitions: [],
    status: 'observed',
    posts: [],
    stopReason: 'cursor_exhausted',
    budgetUsage: usage(),
    location: null,
    barrier: null,
    ...over,
  };
}

type SearchResult = Extract<XResearchResult, { operation: 'search' }>;

function searchResult(rows: XSearchObservation[], over: Partial<SearchResult> = {}): SearchResult {
  return {
    schemaVersion: 2, sourceKind: 'page_graphql', operation: 'search',
    callId: 'call-1', batchId: 'batch-1', runId: 'run-1', browserTabId: 'tab-1',
    objective: 'Qwen3.8 27B 量化版在 agentic 任务上的表现', status: 'observed', budgetUsage: usage(),
    truncation: { returned: rows.length, totalKnown: rows.length, truncated: false },
    queries: rows, ...over,
  };
}

/** 采集层的替身：把请求原样回成结果（行序 = 工作项序），不碰浏览器。 */
const echoSearch: XResearchRunWork = async (work) => {
  if (!('search' in work)) throw new Error('search work expected');
  return searchResult(work.search.queries.map((query) => searchRow({ query })));
};

function harness(runWork: XResearchRunWork) {
  const threadId = randomUUID();
  const service = new XResearchTaskService({
    store: new XResearchTaskStore(root()), runWork, onUpdate: () => undefined,
    artifacts: () => tempXArtifactStore(),
  });
  const observed: XResearchResult[] = [];
  const tool = createXResearchTools({
    service, threadId, projectRoot: '/projects/demo', currentRunId: () => 'run-1',
    observeDelivery: (result) => { observed.push(result); },
  });
  return { tool, service, threadId, observed };
}

type Tool = ReturnType<typeof createXResearchTools>;
type ToolResult = Awaited<ReturnType<Tool['execute']>>;

function execute(tool: Tool, raw: Record<string, unknown>, callId = 'call-1'): Promise<ToolResult> {
  return tool.execute(callId, raw as never, undefined, undefined, {} as never);
}

function envelopeOf(result: ToolResult): XResearchDeliveryEnvelope {
  return result.details as XResearchDeliveryEnvelope;
}

/** `inspect` 的那一页：壳里的 `items` 是 `unknown[]`（壳不 import 采集层的行类型）。 */
function inspectItems(envelope: XResearchDeliveryEnvelope): Array<Record<string, unknown>> {
  return (envelope.inspect?.items ?? []) as Array<Record<string, unknown>>;
}

describe('x_research submit', () => {
  it('submit returns before the work finishes', async () => {
    // R13：队列在 submit 返回的同一微任务里就开始了，所以「不等工作」要用**闸住的**假 runner 证明。
    const release = gate();
    const { tool, service, threadId } = harness(async (work) => {
      await release.promise;
      if (!('search' in work)) throw new Error('search work expected');
      return searchResult(work.search.queries.map((query) => searchRow({ query })));
    });
    const submitted = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    expect(submitted.action).toBe('submit');
    // 工作还没完成就已经有快照，且它说的是「在跑」，不是「还没开始」。
    expect(submitted.snapshot.state).toBe('running');
    expect(submitted.snapshot.search).toEqual([expect.objectContaining({ state: 'queued' })]);
    expect(submitted.delivery).toBeUndefined();
    release.open();
    await service.whenIdle(threadId, submitted.researchRunId);
    expect((await service.get(threadId, submitted.researchRunId)).state).toBe('completed');
  });

  it('requires exactly one of search/read on submit', async () => {
    const { tool } = harness(echoSearch);
    await expect(execute(tool, { action: 'submit', search: searchArgs(), read: readArgs() }))
      .rejects.toThrow('exactly one of search/read');
    await expect(execute(tool, { action: 'submit' })).rejects.toThrow('exactly one of search/read');
    // 正例：只给一支就能提交（否则上面两条的「拒绝」可能只是拒绝了一切）。
    const submitted = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    expect(submitted.snapshot.search).toHaveLength(1);
  });

  it('rejects read work that names a foreign tab', async () => {
    // 标签页归属由工作体判（`xResearchRunner` 拿任务的 tab 调 `researchTabStatus`）：提交方不再回传
    // `tabId`，所以这条在动作面上的可观测形态是「这一轮收尾成中断、永远不产出可交付的结果」。
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { tool, service, threadId, observed } = harness(async () => {
      throw new Error('X research tab belongs to another thread');
    });
    const submitted = envelopeOf(await execute(tool, { action: 'submit', read: readArgs() }));
    await service.whenIdle(threadId, submitted.researchRunId);
    const waited = envelopeOf(await execute(tool, { action: 'wait', researchRunId: submitted.researchRunId }));
    expect(waited.delivery).toBeUndefined();
    expect(waited.snapshot.state).toBe('interrupted');
    // 没收尾的行落进「中断」桶：既不说成失败，也不说成完成。
    expect(waited.snapshot.counts.interrupted).toBe(1);
    expect(observed).toHaveLength(0);
  });

  it('computes the budget labels from the raw arguments, not from the parsed work', async () => {
    // R19：`origin` 看的是「这个键写没写」，只有原始参数说得清；runner 只透传。
    const budgets: Array<XBudgetPolicy | undefined> = [];
    const { tool, service, threadId } = harness(async (work, ctx) => {
      budgets.push(work.budgetPolicy);
      return echoSearch(work, ctx);
    });
    const explicit = envelopeOf(await execute(tool, {
      action: 'submit', search: searchArgs({ maxPostsPerQuery: 7 }),
    }));
    await service.whenIdle(threadId, explicit.researchRunId);
    expect(budgets[0]).toEqual({
      posts: { limit: 7, origin: 'explicit' },
      scrolls: { limit: 500, origin: 'default' },
    });
    const defaults = envelopeOf(await execute(tool, {
      action: 'submit', researchRunId: explicit.researchRunId, search: searchArgs(),
    }));
    await service.whenIdle(threadId, explicit.researchRunId);
    expect(budgets[1]).toEqual({
      posts: { limit: 500, origin: 'default' },
      scrolls: { limit: 500, origin: 'default' },
    });
    expect(defaults.researchRunId).toBe(explicit.researchRunId);
  });
});

describe('x_research wait', () => {
  it('delivers one submission at a time and observes each exactly once', async () => {
    const { tool, service, threadId, observed } = harness(echoSearch);
    const first = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    await execute(tool, { action: 'submit', researchRunId: first.researchRunId, search: searchArgs() });
    await service.whenIdle(threadId, first.researchRunId);

    const a = envelopeOf(await execute(tool, { action: 'wait', researchRunId: first.researchRunId }, 'wait-1'));
    expect(a.action).toBe('wait');
    expect(a.delivery).toBeDefined();
    expect(a.delivery?.deliveryCallId).toBe('wait-1');
    expect(observed).toHaveLength(1);
    // 账本拿到的是那一条交付本身（壳里的 `details` 是从同一份字节反解的副本，值相同）。
    expect(observed[0]).toEqual(a.delivery?.result);
    // 另一份还在队列里没交出去：清单说的和计数说的是同一件事。
    expect(a.undelivered).toHaveLength(1);
    expect(a.snapshot.counts.undelivered).toBe(1);

    const b = envelopeOf(await execute(tool, { action: 'wait', researchRunId: first.researchRunId }, 'wait-2'));
    expect(b.delivery?.submissionId).not.toBe(a.delivery?.submissionId);
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(b.delivery?.result);
    expect(b.undelivered).toBeUndefined();

    // 第三次没有可交付的：账本不再被喂一次。
    const c = envelopeOf(await execute(tool, { action: 'wait', researchRunId: first.researchRunId }, 'wait-3'));
    expect(c.delivery).toBeUndefined();
    expect(observed).toHaveLength(2);
  });
});

describe('x_research inspect', () => {
  it('pages rows within a submission and never becomes a delivery', async () => {
    const { tool, service, threadId, observed } = harness(echoSearch);
    const submitted = envelopeOf(await execute(tool, {
      action: 'submit', search: searchArgs({ queries }),
    }));
    await service.whenIdle(threadId, submitted.researchRunId);

    const firstPage = envelopeOf(await execute(tool, {
      action: 'inspect', researchRunId: submitted.researchRunId, view: 'rows', pageSize: 1,
    }, 'inspect-1'));
    expect(firstPage.action).toBe('inspect');
    expect(firstPage.inspect?.view).toBe('rows');
    expect(inspectItems(firstPage)).toEqual([
      expect.objectContaining({ submissionId: expect.any(String), operation: 'search', index: 0 }),
    ]);
    expect(firstPage.inspect?.nextCursor).toBeDefined();
    // `inspect` 不交付：证据账本一次都不该被喂。
    expect(observed).toHaveLength(0);

    const secondPage = envelopeOf(await execute(tool, {
      action: 'inspect', researchRunId: submitted.researchRunId, view: 'rows', pageSize: 1,
      cursor: firstPage.inspect?.nextCursor,
    }, 'inspect-2'));
    expect(inspectItems(secondPage).map((item) => item.index)).toEqual([1]);
    expect(secondPage.inspect?.nextCursor).toBeUndefined();

    const deliveries = envelopeOf(await execute(tool, {
      action: 'inspect', researchRunId: submitted.researchRunId, view: 'deliveries',
    }, 'inspect-3'));
    expect(inspectItems(deliveries)).toEqual([
      expect.objectContaining({ deliveredAt: null, deliveryCallId: null }),
    ]);
  });

  it('lists only concluded failures with their reason', async () => {
    const partlyFailed: XResearchRunWork = async (work) => {
      if (!('search' in work)) throw new Error('search work expected');
      const [first, second] = work.search.queries;
      return searchResult([
        searchRow({ query: first, status: 'failed', stopReason: 'source_unavailable' }),
        ...(second ? [searchRow({ query: second })] : []),
      ]);
    };
    const { tool, service, threadId } = harness(partlyFailed);
    const submitted = envelopeOf(await execute(tool, {
      action: 'submit', search: searchArgs({ queries }),
    }));
    await service.whenIdle(threadId, submitted.researchRunId);
    const failures = envelopeOf(await execute(tool, {
      action: 'inspect', researchRunId: submitted.researchRunId, view: 'failures',
    }, 'inspect-failures'));
    expect(inspectItems(failures)).toEqual([
      expect.objectContaining({ status: 'failed', stopReason: 'source_unavailable', index: 0 }),
    ]);
    // 翻面：同一条研究的两行里只有一行失败，`rows` 看得见两行 —— 上面的「只有一行」不是因为全都看不见。
    const rows = envelopeOf(await execute(tool, {
      action: 'inspect', researchRunId: submitted.researchRunId, view: 'rows',
    }, 'inspect-rows'));
    expect(inspectItems(rows)).toHaveLength(2);
    expect(failures.snapshot.counts.failed).toBe(1);
  });
});

describe('x_research cancel', () => {
  it('settles the queue without starting it and keeps finished deliveries deliverable', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const calls: string[] = [];
    const secondStarted = gate();
    const { tool, service, threadId, observed } = harness(async (work, ctx) => {
      calls.push(ctx.submissionId);
      if (calls.length === 2) {
        secondStarted.open();
        // 采集层照 `ctx.signal` 收尾：cancel 之后这里当场拒绝，不留下「跑了一半当成功」。
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')));
        });
      }
      return echoSearch(work, ctx);
    });
    const first = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    await service.whenIdle(threadId, first.researchRunId);
    await execute(tool, { action: 'submit', researchRunId: first.researchRunId, search: searchArgs() });
    await execute(tool, { action: 'submit', researchRunId: first.researchRunId, search: searchArgs() });
    await secondStarted.promise;

    const cancelled = envelopeOf(await execute(tool, {
      action: 'cancel', researchRunId: first.researchRunId,
    }, 'cancel-1'));
    expect(cancelled.action).toBe('cancel');
    // 排队中的那一份一次都没起跑：cancel 之后没有任何导航发生。
    expect(calls).toHaveLength(2);
    expect(cancelled.snapshot.counts).toMatchObject({ done: 1, cancelled: 2 });
    // 投影：不是全部取消（有一份已完成），所以状态词仍是 completed —— `stateReason` 记下「被取消过」。
    expect(cancelled.status).toBe('completed');
    expect(cancelled.snapshot.stateReason).toBe('cancelled');

    // 取消不使已完成的交付失效（spec §4.2）：第一份照样交得出去，只要 wait。
    const waited = envelopeOf(await execute(tool, {
      action: 'wait', researchRunId: first.researchRunId,
    }, 'wait-1'));
    expect(waited.delivery).toBeDefined();
    expect(observed).toHaveLength(1);

    // 已取消的研究不能再追加工作：静默地把它写成 cancelled 会让模型以为工作排上了。
    await expect(execute(tool, { action: 'submit', researchRunId: first.researchRunId, search: searchArgs() }))
      .rejects.toThrow('cancelled');
  });

  it('reports the cancelled state when nothing had finished', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const started = gate();
    const { tool } = harness(async (work, ctx) => {
      started.open();
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')));
      });
      return echoSearch(work, ctx);
    });
    const submitted = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    await started.promise;
    const cancelled = envelopeOf(await execute(tool, {
      action: 'cancel', researchRunId: submitted.researchRunId,
    }, 'cancel-1'));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.snapshot.counts).toMatchObject({ cancelled: 1, interrupted: 0 });
  });
});

it('returns the same four protocol keys for every action', async () => {
  const { tool, service, threadId } = harness(echoSearch);
  const submitted = await execute(tool, { action: 'submit', search: searchArgs() });
  const researchRunId = envelopeOf(submitted).researchRunId;
  await service.whenIdle(threadId, researchRunId);
  const results: Array<[string, ToolResult]> = [
    ['submit', submitted],
    ['inspect', await execute(tool, { action: 'inspect', researchRunId, view: 'rows' }, 'inspect-1')],
    ['wait', await execute(tool, { action: 'wait', researchRunId }, 'wait-1')],
    ['cancel', await execute(tool, { action: 'cancel', researchRunId }, 'cancel-1')],
  ];
  for (const [action, result] of results) {
    const envelope = envelopeOf(result);
    expect(envelope).toMatchObject({
      kind: 'x_research', action, researchRunId, status: expect.any(String),
    });
    // 壳与 `content` 是同一份字节：模型看的就是 `details`。
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(envelope);
  }
});
