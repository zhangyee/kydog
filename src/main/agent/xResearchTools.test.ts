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
import { X_RESEARCH_MAX_OUTPUT_BYTES, type XResearchResult, type XSearchObservation, type XSearchQuery } from '../x/xResearchTypes';
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

/** 同一个入口，但把 pi 这一轮的中止信号真的传下去（用户按停止走的就是它）。 */
function executeWithSignal(tool: Tool, raw: Record<string, unknown>, signal: AbortSignal,
  callId = 'call-1'): Promise<ToolResult> {
  return tool.execute(callId, raw as never, signal, undefined, {} as never);
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
    expect(submitted.deliveries).toBeUndefined();
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

  it('treats a null payload as absent instead of rejecting the call', async () => {
    // 现场（R88）：模型发 `{"action":"submit","read":null, <一份合法的 search>}`，被 schema 拒了
    // （`read: must be object`），白掉一轮。`null` 在 JSON 里就是「这一次不用这个载荷」的意思。
    const { tool } = harness(echoSearch);
    const submitted = envelopeOf(await execute(tool, { action: 'submit', read: null, search: searchArgs() }));
    expect(submitted.snapshot.search).toHaveLength(1);
    // 翻面：两支都是 null 就是「什么都没给」，仍按「必须给一支」拒（不把 null 变成一个合法载荷）。
    await expect(execute(tool, { action: 'submit', search: null, read: null }))
      .rejects.toThrow('exactly one of search/read');
  });

  it('rejects out-of-bounds requests before they are queued', async () => {
    const { tool, service } = harness(echoSearch);
    const submit = vi.spyOn(service, 'submit');
    // schema 放行（恰好 4096 units），但构造出来的公开搜索 URL 约 36 KB：越界要在**入队之前**拒。
    // 只在排队的 runner 里拒的话，抛出会被 `run` 的 catch 收成一份 `interrupted` 的提交 ——
    // 模型看到的是一条泛化失败，而不是「把 query 缩短或拆分」。
    await expect(execute(tool, {
      action: 'submit', search: searchArgs({ queries: [{ ...queries[0], query: '汉'.repeat(4096) }] }),
    })).rejects.toThrow('shorten or split the query');
    // read 的 target 越过 8192：解析层先于这一道拒（同一个上限），拒绝同样发生在入队之前。
    await expect(execute(tool, {
      action: 'submit', read: { ...readArgs(), targets: [{ url: `https://x.com/alice/status/1?q=${'x'.repeat(8192)}` }] },
    })).rejects.toThrow('url: expected HTTPS public X post URL');
    expect(submit).not.toHaveBeenCalled();
    // 翻面：边界内侧的同一份请求照常提交（否则「没调用」也可能只是「什么都没跑」）。
    await execute(tool, { action: 'submit', search: searchArgs() });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('never delivers a submission whose work body was refused', async () => {
    // 标签页归属由工作体判（`xResearchRunner` 拿任务的 tab 调 `researchTabStatus`）：提交方不再回传
    // `tabId`，所以这条在动作面上的可观测形态是「这一轮收尾成中断、永远不产出可交付的结果」。
    // 标签页归属本身在 `xResearchRunner.test.ts` 里钉，这里钉的是它落在这个面上的那一半。
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const { tool, service, threadId, observed } = harness(async () => {
      throw new Error('X research tab belongs to another thread');
    });
    const submitted = envelopeOf(await execute(tool, { action: 'submit', read: readArgs() }));
    await service.whenIdle(threadId, submitted.researchRunId);
    const waited = envelopeOf(await execute(tool, { action: 'wait', researchRunId: submitted.researchRunId }));
    expect(waited.deliveries).toBeUndefined();
    expect(waited.snapshot.state).toBe('interrupted');
    // 没收尾的行落进「中断」桶：既不说成失败，也不说成完成。
    expect(waited.snapshot.counts.interrupted).toBe(1);
    expect(observed).toHaveLength(0);
  });

  it('binds an explicit tabId override to the task', async () => {
    const { tool } = harness(echoSearch);
    const bound = envelopeOf(await execute(tool, {
      action: 'submit', tabId: 'tab-9', search: searchArgs(),
    }));
    expect(bound.snapshot.browserTabId).toBe('tab-9');
    // 翻面：同一对话里新开一段研究继承这张页（R81h）—— 不带 `tabId` 的提交拿到的是这个对话此刻的页，
    // 不是回显的默认值。「没有可继承的页时也不凭空造一个」在 `xResearchTaskService.test.ts` 里钳
    // （另一个对话不继承、`forget` 之后不继承、一开始谁也没给页时是 `undefined`）。
    const own = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    expect(own.researchRunId).not.toBe(bound.researchRunId);
    expect(own.snapshot.browserTabId).toBe('tab-9');
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
  it('delivers every finished submission in one wait and observes each exactly once', async () => {
    const { tool, service, threadId, observed } = harness(echoSearch);
    const first = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    await execute(tool, { action: 'submit', researchRunId: first.researchRunId, search: searchArgs() });
    await service.whenIdle(threadId, first.researchRunId);

    const a = envelopeOf(await execute(tool, { action: 'wait', researchRunId: first.researchRunId }, 'wait-1'));
    expect(a.action).toBe('wait');
    // 两份都收尾了：一次 `wait` 全交出去，不再分两次。
    expect(a.deliveries).toHaveLength(2);
    expect(a.deliveries?.map((delivery) => delivery.deliveryCallId)).toEqual(['wait-1', 'wait-1']);
    expect(a.deliveries?.[0]?.submissionId).not.toBe(a.deliveries?.[1]?.submissionId);
    expect(observed).toHaveLength(2);
    // 账本拿到的是每一条交付本身（壳里的 `details` 是从同一份字节反解的副本，值相同）。
    expect(observed).toEqual(a.deliveries?.map((delivery) => delivery.result));
    expect(a.undelivered).toBeUndefined();
    expect(a.snapshot.counts.undelivered).toBe(0);

    // 第二次没有可交付的：一条都不重复，账本也不再被喂。
    const c = envelopeOf(await execute(tool, { action: 'wait', researchRunId: first.researchRunId }, 'wait-2'));
    expect(c.deliveries).toBeUndefined();
    expect(observed).toHaveLength(2);
  });

  it('feeds the ledger only after the envelope fits under 1 MiB', async () => {
    // 账本是「可引用 = 已交付」的那一侧：`deliverEnvelope` 在装不下 1 MiB 时会抛，而抛出的那一刻
    // 这份结果并没有交给模型。先喂账本再搭包络，就会让一份模型从没看到的结果变得可引用。
    const { tool, service, threadId } = harness(echoSearch);
    const submitted = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    await service.whenIdle(threadId, submitted.researchRunId);

    const observed: XResearchResult[] = [];
    // 把服务交出来的那份结果换掉：工具拿到的就是一份装不进包络的结果（壳这一层的 1 MiB 硬失败）。
    const toolWith = (oversized?: XResearchResult) => createXResearchTools({
      service: {
        submit: (input, owner) => service.submit(input, owner),
        inspect: (runThreadId, researchRunId, input) => service.inspect(runThreadId, researchRunId, input),
        cancel: (runThreadId, researchRunId) => service.cancel(runThreadId, researchRunId),
        wait: async (runThreadId, researchRunId, deliveryCallId, signal) => {
          const delivered = await service.wait(runThreadId, researchRunId, deliveryCallId, signal);
          const [delivery] = delivered.deliveries;
          return delivery && oversized
            ? { ...delivered, deliveries: [{ ...delivery, result: oversized }] }
            : delivered;
        },
      },
      threadId, projectRoot: '/projects/demo', currentRunId: () => 'run-1',
      observeDelivery: (result) => { observed.push(result); },
    });

    const oversized = searchResult([searchRow()], {
      objective: 'x'.repeat(X_RESEARCH_MAX_OUTPUT_BYTES + 1),
    });
    const failed = await execute(toolWith(oversized), {
      action: 'wait', researchRunId: submitted.researchRunId,
    }, 'wait-1').then(() => null, (error: unknown) => error);
    expect(String(failed)).toContain('1 MiB');
    // 交付本身发生过（服务那一侧已标 `deliveredAt`），被扣下的只有账本 —— 所以这条 0 次不是
    // 「什么都没发生」。
    const deliveries = envelopeOf(await execute(tool, {
      action: 'inspect', researchRunId: submitted.researchRunId, view: 'deliveries',
    }, 'inspect-1'));
    expect(inspectItems(deliveries)[0]).toMatchObject({ deliveryCallId: 'wait-1' });
    expect(observed).toHaveLength(0);

    // 翻面：同一个替身把结果真的交出去时，账本正好喂一次 —— 上面的 0 次是「包络没装下」，
    // 不是这个替身根本不喂账本。
    await execute(toolWith(), { action: 'submit', researchRunId: submitted.researchRunId, search: searchArgs() });
    await service.whenIdle(threadId, submitted.researchRunId);
    const delivered = envelopeOf(await execute(toolWith(), {
      action: 'wait', researchRunId: submitted.researchRunId,
    }, 'wait-2'));
    expect(delivered.deliveries).toHaveLength(1);
    expect(observed).toHaveLength(1);
  });

  it('abandons a pending wait when the turn is stopped, without consuming a delivery', async () => {
    // 用户按停止：pi 中止这一轮的工具调用，`wait` 必须当场收场，而不是挂到队列排空（20 个目标的
    // read 是几分钟）。同时它不许把一份结果标成交过了 —— 那是「交给了没人接的那一侧」。
    const release = gate();
    const { tool, service, threadId, observed } = harness(async (work) => {
      await release.promise;
      if (!('search' in work)) throw new Error('search work expected');
      return searchResult(work.search.queries.map((query) => searchRow({ query })));
    });
    const submitted = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    const controller = new AbortController();
    const waiting = executeWithSignal(tool, {
      action: 'wait', researchRunId: submitted.researchRunId,
    }, controller.signal, 'wait-1').then(
      () => 'resolved',
      (error: unknown) => `rejected:${String((error as { code?: unknown }).code)}`,
    );
    controller.abort();
    // 队列还闸着：能在它排空之前收场，才叫「中止当场放手」。
    expect(await Promise.race([
      waiting, new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 100)),
    ])).toBe('rejected:agent.aborted');
    // 中止不消费交付：账本没被喂，盘上也没有交付标记。
    expect(observed).toHaveLength(0);
    const deliveries = envelopeOf(await execute(tool, {
      action: 'inspect', researchRunId: submitted.researchRunId, view: 'deliveries',
    }, 'inspect-1'));
    expect(inspectItems(deliveries)).toEqual([expect.objectContaining({ deliveredAt: null, deliveryCallId: null })]);

    // 翻面：那一份结果现在还能真交出去一次（中止没有把它吃掉），且账本只因此喂一次。
    release.open();
    await service.whenIdle(threadId, submitted.researchRunId);
    const delivered = envelopeOf(await execute(tool, {
      action: 'wait', researchRunId: submitted.researchRunId,
    }, 'wait-2'));
    expect(delivered.deliveries?.[0]?.deliveryCallId).toBe('wait-2');
    expect(delivered.undelivered).toBeUndefined();
    expect(observed).toHaveLength(1);
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
    // 主语是**模型**（R81a）：工具的 cancel 不是用户按了停止，卡头不该说「你取消的」。
    expect(cancelled.snapshot.cancelledBy).toBe('agent');
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
    expect(waited.deliveries).toHaveLength(1);
    expect(observed).toHaveLength(1);
    // 「被取消过」是**黏的**：这次 `wait` 落盘没有理由可写，但它不许把取消这件事擦掉 —— 否则重启之后
    // （`cancelRequested` 只在内存里）就只剩 `stateReason` 能认出这段研究被停过。
    expect(waited.snapshot.stateReason).toBe('cancelled');
    expect((await service.get(threadId, first.researchRunId)).stateReason).toBe('cancelled');

    // 取消**不封研究**（R83）：停下的那两轮永远是取消的，而同一段研究可以接着提交**新一轮** ——
    // 「停下这一轮」与「这一段再也做不了」是两件事。新的一轮真跑，取消的那两份一行都不改。
    const continued = envelopeOf(await execute(tool, {
      action: 'submit', researchRunId: first.researchRunId, search: searchArgs(),
    }));
    expect(continued.researchRunId).toBe(first.researchRunId);
    // 提交那一刻就回到「进行中」：`record.state` 是提交重算出来的，不是被取消钉死的。
    expect(continued.snapshot.state).toBe('running');
    await service.whenIdle(threadId, first.researchRunId);
    const after = envelopeOf(await execute(tool, {
      action: 'wait', researchRunId: first.researchRunId,
    }, 'wait-2'));
    expect(after.deliveries).toHaveLength(1);
    expect(after.snapshot.state).toBe('completed');
    // 取消那两份仍是取消（从没被重跑：工作体只被调了三次 —— 第一份、被取消的那份、新的这份）。
    expect(after.snapshot.counts).toMatchObject({ cancelled: 2, done: 2, queued: 0, running: 0 });
    expect(after.snapshot.rounds!.filter((round) => round.state === 'cancelled')).toHaveLength(2);
    expect(calls).toHaveLength(3);
    // 翻面：一段从没被取消过的研究在同一刻没有理由可说 —— 上面那些 `cancelled` 不是「谁都带上」。
    const fresh = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    expect(fresh.researchRunId).not.toBe(first.researchRunId);
    const freshWait = envelopeOf(await execute(tool, {
      action: 'wait', researchRunId: fresh.researchRunId,
    }, 'wait-3'));
    expect(freshWait.deliveries).toHaveLength(1);
    expect(freshWait.snapshot.stateReason).toBeUndefined();
    expect((await service.get(threadId, fresh.researchRunId)).stateReason).toBeUndefined();
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

  it('keeps a submission that finished before the cancellation could stop it', async () => {
    // 取消落在收尾之后：工作体不听 `ctx.signal`（采集恰好在那一刻跑完了），于是这一份已经有结论。
    // 取消不是用来抹掉已经观察到的事实的 —— 它只给还没收尾的那一份写结论。
    const started = gate();
    const stopped = gate();
    const releaseBody = gate();
    const { tool } = harness(async (work, ctx) => {
      started.open();
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => { stopped.open(); void releaseBody.promise.then(resolve); });
      });
      return echoSearch(work, ctx);
    });
    const submitted = envelopeOf(await execute(tool, { action: 'submit', search: searchArgs() }));
    await started.promise;
    const cancelling = execute(tool, { action: 'cancel', researchRunId: submitted.researchRunId }, 'cancel-1');
    // 取消已经落地（`cancelRequested` 已置、信号已发）之后，工作体才收尾。
    await stopped.promise;
    releaseBody.open();
    const cancelled = envelopeOf(await cancelling);

    const deliveries = envelopeOf(await execute(tool, {
      action: 'inspect', researchRunId: submitted.researchRunId, view: 'deliveries',
    }, 'inspect-1'));
    const [entry] = inspectItems(deliveries);
    expect(inspectItems(deliveries)).toHaveLength(1);
    expect(entry).toMatchObject({ state: 'done', deliveredAt: null });
    expect(cancelled.snapshot.counts.done).toBe(1);
    expect(cancelled.snapshot.counts.cancelled).toBe(0);
    // 翻面：它仍然交得出去 —— 保住结论不是把结果扣下。
    const waited = envelopeOf(await execute(tool, {
      action: 'wait', researchRunId: submitted.researchRunId,
    }, 'wait-1'));
    expect(waited.deliveries?.[0]?.submissionId).toBe(entry.submissionId);
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
