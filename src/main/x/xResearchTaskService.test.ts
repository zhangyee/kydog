import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  XResearchSubmission, XResearchTaskRecord, XResearchTaskSnapshot, XResearchWorkItem,
} from '../../shared/xResearchTask';
import { logger } from '../log';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import type { XNetworkPageFact } from './xNetworkLease';
import type { XResearchArtifactStore } from './xResearchArtifacts';
import { XResearchTaskStore } from './xResearchTaskStore';
import {
  XResearchTaskService, registerXResearchTaskService, xResearchTaskService, type XResearchRunWork,
} from './xResearchTaskService';
import type {
  XArticleFacts, XArtifactRef, XReadObservation, XReadRequest, XResearchResult, XSearchObservation,
  XSearchRequest, XTextObservation,
} from './xResearchTypes';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xtask-service-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  // 一个断言失败时漏出去的 spy 会污染后面的用例（比如 `logger.warn` 被永久换成 mock）。
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function owner(): { threadId: string; runId: string; projectRoot: string } {
  return { threadId: randomUUID(), runId: randomUUID(), projectRoot: '/projects/demo' };
}

/** 一个由用例决定何时放行的闸门：用来把「这一轮还在飞」钉成事实，不靠 sleep。 */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

const searchWork = (over: Partial<XSearchRequest> = {}): XSearchRequest => ({
  objective: 'Qwen3.8 27B 量化版在 agentic 任务上的实际表现',
  queries: [
    { id: 'q1', query: 'Qwen3.8 27B', purpose: '看实际表现', product: 'Top' },
    { id: 'q2', query: 'Qwen3.8 27B Q4', purpose: '看量化版', product: 'Latest' },
  ],
  maxPostsPerQuery: 500,
  maxScrollsPerQuery: 500,
  ...over,
});

const readWork = (over: Partial<XReadRequest> = {}): XReadRequest => ({
  objective: '读这两条帖子的正文与回复',
  targets: [{ postId: '19581' }, { url: 'https://x.com/kydog/status/19583' }],
  includeArticle: true,
  includeReplies: true,
  maxRepliesPerPost: 500,
  maxScrollsPerPost: 500,
  maxExpandActionsPerPost: 200,
  ...over,
});

const usage = (over: Partial<XSearchObservation['budgetUsage']> = {}): XSearchObservation['budgetUsage'] =>
  ({ scrolls: 0, expandActions: 0, distinctEntries: 0, outputBytes: 0, ...over });

function pageFact(over: Partial<XNetworkPageFact> = {}): XNetworkPageFact {
  return {
    provenance: {
      leaseId: 'lease-1', requestRef: 'req-1', navigationId: 'nav-1', documentEpoch: 1,
      routeRevision: 1, navigationSequence: 1, operation: 'SearchTimeline',
      observedAt: '2026-10-16T00:00:00.000Z',
    },
    bytes: 1024, sha256: 'a'.repeat(64), inputCursorRef: null, outputCursorRef: null,
    end: 'unknown', observed: 15, sampled: 12, omitted: 3, unsupported: [], ...over,
  };
}

function postBase() {
  return {
    observationId: randomUUID(), sourceKind: 'rendered_ui' as const,
    sourceUrl: 'https://x.com/kydog/status/19581', author: null, text: '观测到的正文',
    observedAt: '2026-10-16T00:00:00.000Z', truncation: { returned: 1, totalKnown: 1, truncated: false },
  };
}

const rootPost = (postId = '19581'): XTextObservation =>
  ({ ...postBase(), containerKind: 'root_post', postId });
const replyPost = (postId: string): XTextObservation =>
  ({ ...postBase(), containerKind: 'reply', postId, directParent: null });
const articlePost = (postId: string): XTextObservation =>
  ({ ...postBase(), containerKind: 'article', postId });

function searchRow(over: Partial<XSearchObservation> = {}): XSearchObservation {
  return {
    query: { id: 'q1', query: 'Qwen3.8 27B', purpose: '看实际表现', product: 'Top' },
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

function articleFacts(over: Partial<XArticleFacts> = {}): XArticleFacts {
  return {
    requested: true, entryObserved: false, actionAttempted: false, navigationStarted: false,
    bodyObserved: false, entry: null, body: null, barrier: null, ...over,
  };
}

function replies(observations: XTextObservation[] = [],
  over: Partial<XReadObservation['replies']> = {}): XReadObservation['replies'] {
  return {
    requested: true,
    observations,
    scope: {
      completeness: 'unknown', endEvidence: null, rootPostId: '19581', branch: null,
      sort: null, stopReason: 'cursor_exhausted', displayedReplyCount: null,
    },
    ...over,
  };
}

function readRow(over: Partial<XReadObservation> = {}): XReadObservation {
  return {
    target: { postId: '19581' },
    collectionTransitions: [],
    documentSource: null,
    inputKind: 'postId',
    inputUrlRedacted: false,
    postId: '19581',
    inputUrl: null,
    sourceUrl: 'https://x.com/kydog/status/19581',
    status: 'observed',
    reason: null,
    root: null,
    quotedPosts: [],
    article: articleFacts(),
    replies: replies(),
    stopReason: 'cursor_exhausted',
    budgetUsage: usage(),
    location: null,
    barrier: null,
    ...over,
  };
}

type SearchResult = Extract<XResearchResult, { operation: 'search' }>;
type ReadResult = Extract<XResearchResult, { operation: 'read' }>;

function searchResult(queries: XSearchObservation[], over: Partial<SearchResult> = {}): SearchResult {
  return {
    schemaVersion: 2, sourceKind: 'page_graphql', operation: 'search',
    callId: 'call-1', batchId: 'batch-1', runId: 'run-1', browserTabId: 'tab-1',
    objective: searchWork().objective, status: 'observed', budgetUsage: usage(),
    truncation: { returned: queries.length, totalKnown: queries.length, truncated: false },
    queries, ...over,
  };
}

function readResult(targets: XReadObservation[], over: Partial<ReadResult> = {}): ReadResult {
  return {
    schemaVersion: 2, sourceKind: 'page_graphql', operation: 'read',
    callId: 'call-1', batchId: 'batch-1', runId: 'run-1', browserTabId: 'tab-1',
    objective: readWork().objective, status: 'observed', budgetUsage: usage(),
    truncation: { returned: targets.length, totalKnown: targets.length, truncated: false },
    targets, ...over,
  };
}

/** 采集层的替身：把请求原样回成结果（行序 = 工作项序），不碰浏览器。 */
const echoRunner: XResearchRunWork = async (work) => ('search' in work
  ? searchResult(work.search.queries.map((query) => searchRow({ query })))
  : readResult(work.read.targets.map((target) => readRow({ target }))));

function harness(runWork: XResearchRunWork, options: {
  store?: XResearchTaskStore;
  now?: () => string;
  /** 交付要回到工件（重启后）的用例自己给一个：它的读是这一层唯一能闸住的交付前 await。 */
  artifacts?: () => XResearchArtifactStore;
} = {}) {
  const store = options.store ?? new XResearchTaskStore(root());
  const frames: XResearchTaskSnapshot[] = [];
  const service = new XResearchTaskService({
    store, runWork, onUpdate: (snapshot) => frames.push(snapshot),
    // 这些用例不碰交付的工件路径（`wait` 的回归在 `xResearchDeliver.test.ts`）：给一个空根即可。
    artifacts: options.artifacts ?? (() => tempXArtifactStore()),
    ...(options.now ? { now: options.now } : {}),
  });
  return { store, service, frames };
}

/** 记下两种落盘的先后：崩溃窗口里能出现哪种形状，取决于这里的顺序。 */
class RecordingStore extends XResearchTaskStore {
  readonly writeOrder: string[] = [];
  override async writeTask(record: XResearchTaskRecord): Promise<void> {
    this.writeOrder.push('task');
    return super.writeTask(record);
  }
  override async writeSubmission(submission: XResearchSubmission): Promise<void> {
    this.writeOrder.push('submission');
    return super.writeSubmission(submission);
  }
}

/** 记下「交付标记那笔写」落盘了没有：它写在 `wait` 返回之后（spec §4.5），于是「拆除有没有等它」
 *  是可以直接观察的事实，不用靠计时器。 */
class DeliveryWriteProbeStore extends XResearchTaskStore {
  deliveryWritten = false;
  override async writeSubmission(submission: XResearchSubmission): Promise<void> {
    await super.writeSubmission(submission);
    if (submission.deliveredAt) this.deliveryWritten = true;
  }
}

/** 可以中途拒绝写提交的盘：用来证明 `submit` 落盘失败时不在内存里留下一条孤儿提交。 */
class FailingSubmissionStore extends XResearchTaskStore {
  failWrites = false;
  override async writeSubmission(submission: XResearchSubmission): Promise<void> {
    if (this.failWrites) throw new Error('disk full');
    return super.writeSubmission(submission);
  }
}

/** 上膛之后把**下一次**提交写闸住再拒绝：用来制造「一份提交在落盘，另一份抢在它后面提交」的窗口。 */
class BlockingSubmissionStore extends XResearchTaskStore {
  readonly entered = gate();
  readonly release = gate();
  private armed = false;
  private calls = 0;
  arm(): void { this.armed = true; }
  override async writeSubmission(submission: XResearchSubmission): Promise<void> {
    if (this.armed) {
      this.calls += 1;
      if (this.calls === 1) {
        this.entered.open();
        await this.release.promise;
        throw new Error('disk full');
      }
    }
    return super.writeSubmission(submission);
  }
}

function workItem(over: Partial<XResearchWorkItem> = {}): XResearchWorkItem {
  return {
    workItemId: randomUUID(), section: 'search', label: 'Qwen3.8 27B', product: 'Top',
    state: 'queued', phaseDetail: null, status: null, stopReason: null, reason: null,
    posts: 0, omitted: 0, pages: 0, hasRoot: false, replies: 0, article: 'not_requested',
    scrolls: 0, expandActions: 0, ...over,
  };
}

/** 一条已经停在盘上的提交（不经 `submit` 造出来，用来表示「上一个进程留下的」）。 */
function storedSubmission(over: Partial<XResearchSubmission> & {
  threadId: string; researchRunId: string;
}): XResearchSubmission {
  return {
    version: 1, submissionId: randomUUID(), submitCallId: randomUUID(), batchId: 'xbatch_stored',
    runId: randomUUID(), operation: 'search', objective: searchWork().objective,
    state: 'running', budget: { scrolls: 1000, expandActions: 0 },
    usage: { posts: 0, scrolls: 0, expandActions: 0 }, workItems: [workItem()],
    createdAt: '2026-10-16T00:00:00.000Z', endedAt: null, ...over,
  };
}

describe('XResearchTaskService', () => {
  it('runs two submissions on the same thread one after another', async () => {
    const order: string[] = [];
    const runWork: XResearchRunWork = async (work, ctx) => {
      order.push(`start:${ctx.submissionId}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`end:${ctx.submissionId}`);
      return echoRunner(work, ctx);
    };
    const { service } = harness(runWork);
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    const second = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    expect(order).toEqual([
      `start:${first.submissionId}`, `end:${first.submissionId}`,
      `start:${second.submissionId}`, `end:${second.submissionId}`,
    ]);
  });

  it('keeps two threads independent', async () => {
    const order: string[] = [];
    const bothStarted = gate();
    const runWork: XResearchRunWork = async (work, ctx) => {
      order.push(`start:${ctx.submissionId}`);
      if (order.length === 2) bothStarted.open();
      // 两个 thread 各有一条链时，这里会同时放行；串成一条链时只有第一个 start，
      // 闸门靠 timeout 兜底，于是失败形态是一条清楚的断言而不是挂死。
      await Promise.race([bothStarted.promise, new Promise((resolve) => setTimeout(resolve, 250))]);
      order.push(`end:${ctx.submissionId}`);
      return echoRunner(work, ctx);
    };
    const { service } = harness(runWork);
    const first = owner();
    const second = owner();
    const a = await service.submit({ work: { search: searchWork() } }, first);
    const b = await service.submit({ work: { search: searchWork() } }, second);
    await service.whenIdle(first.threadId, a.researchRunId);
    await service.whenIdle(second.threadId, b.researchRunId);
    expect(order.slice(0, 2).sort()).toEqual([`start:${a.submissionId}`, `start:${b.submissionId}`].sort());
    expect(order).toHaveLength(4);
  });

  it('appends a second submission to the same researchRunId', async () => {
    const { service, store } = harness(echoRunner);
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    const second = await service.submit({ researchRunId: first.researchRunId, work: { read: readWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    expect(second.researchRunId).toBe(first.researchRunId);
    const snapshot = await service.get(thread.threadId, first.researchRunId);
    // 两份都跑成功了：终态必须是「完成」。只断行级桶的话，`project()` 把跑完的提交说成中断
    // 也能让下面每条都绿（行都会照结果收尾）。
    expect(snapshot.state).toBe('completed');
    expect((await store.readTask(thread.threadId, first.researchRunId))?.state).toBe('completed');
    expect(snapshot.counts.submissions).toBe(2);
    expect(snapshot.search).toHaveLength(2);
    expect(snapshot.read).toHaveLength(2);
    // 卡头取**最早**一次提交的 objective：后续提交只是往同一段研究里追加步骤（R10）。
    expect(snapshot.objective).toBe(searchWork().objective);
    // 读取行没有 `url` 时标签就是 postId 本身 —— 采集层「从不生成 permalink」，这里也不造一个。
    expect(snapshot.read.map((item) => item.label)).toEqual(['19581', 'https://x.com/kydog/status/19583']);
    // 预算按提交各自声明的上限相加（spec §6.7）：2 query × 500 + 2 目标 × 500 滚动、2 × 200 展开。
    expect(snapshot.budget).toEqual({ scrolls: 2000, expandActions: 400 });
  });

  it('hands the work body a tab binding onto the task record', async () => {
    const bound = gate();
    const release = gate();
    const seen: (string | undefined)[] = [];
    const { service, store } = harness(async (work, ctx) => {
      // 提交时显式给了 tabId：工作体读到的就是任务记的那个。
      seen.push(ctx.tabBinding.get());
      ctx.tabBinding.set('tab-9');
      seen.push(ctx.tabBinding.get());
      bound.open();
      await release.promise;
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() }, tabId: 'tab-7' }, thread);
    await bound.promise;
    expect(seen).toEqual(['tab-7', 'tab-9']);
    // 任务持有标签页（spec §4.3）：采集层写回的值在快照上看得见，下一轮提交复用它。
    expect((await service.get(thread.threadId, submitted.researchRunId)).browserTabId).toBe('tab-9');
    release.open();
    await service.whenIdle(thread.threadId, submitted.researchRunId);
    // 新的 service 实例（内存里没有活副本）= 从盘上重开：写回的值跟着这一轮的收尾落了盘。
    const reopened = harness(echoRunner, { store });
    expect((await reopened.service.get(thread.threadId, submitted.researchRunId)).browserTabId).toBe('tab-9');
  });

  it('remembers the tab the collector wrote back for the whole thread', async () => {
    const seen: (string | undefined)[] = [];
    const { service } = harness(async (work, ctx) => {
      seen.push(ctx.tabBinding.get());
      ctx.tabBinding.set('tab-of-this-thread');
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    // 前提：第一段研究一开始谁也没给它页。
    expect(seen).toEqual([undefined]);
    // 同一对话里新开一段研究：一开始就拿得到上一段留下的页（R81h）—— 取消后重试不必让模型
    // 再 `browser_tabs` 找一次页。
    const second = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, second.researchRunId);
    expect(second.researchRunId).not.toBe(first.researchRunId);
    expect(seen).toEqual([undefined, 'tab-of-this-thread']);
    expect((await service.get(thread.threadId, second.researchRunId)).browserTabId)
      .toBe('tab-of-this-thread');

    // 翻面：另一个对话不继承（记住的是「这条对话的页」，不是一张全局页）。
    const other = owner();
    const third = await service.submit({ work: { search: searchWork() } }, other);
    await service.whenIdle(other.threadId, third.researchRunId);
    expect(seen[2]).toBeUndefined();

    // 翻面二：**带着账本身份**的那次拆除（换会话时 `disposeThread` 走的就是它）不算「这条对话没了」
    // —— 页还活着，新的那一段研究照样继承它（R46/R47 的同一条边界）。
    service.forget(thread.threadId, {});
    const replaced = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, replaced.researchRunId);
    expect(seen[3], '带着账本身份的拆除不该把这条对话的页丢掉').toBe('tab-of-this-thread');

    // 对话被拆除 / 删除（`disposeThread` / `forgetXResearchThread` 走的就是整条拆除）：这条 thread
    // 不再有页可继承。
    service.forget(thread.threadId);
    const fourth = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, fourth.researchRunId);
    expect(seen[4]).toBeUndefined();
  });

  it('remembers an explicitly submitted tab for the rest of the thread', async () => {
    const seen: (string | undefined)[] = [];
    const { service } = harness(async (work, ctx) => {
      seen.push(ctx.tabBinding.get());
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() }, tabId: 'tab-explicit' }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    const second = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, second.researchRunId);
    // 两段研究拿到同一张页：第一段是提交时显式给的，第二段是同一对话里新建的、从对话上继承的。
    expect(seen).toEqual(['tab-explicit', 'tab-explicit']);
  });

  it('emits a snapshot on submit before any work runs', async () => {
    const hold = gate();
    // 工作体开跑时已经推过几帧：这才是「提交先推帧、再排队」的可观察形式 ——
    // 闸住的假 runner 让 `frames[0]` 在违规实现下也长得一模一样（提交帧与开跑帧的内容逐字相同），
    // 所以不能只断 `frames[0]`。
    const entered = gate();
    const framesOnEntry: number[] = [];
    const { service, frames } = harness(async (work, ctx) => {
      framesOnEntry.push(frames.length);
      entered.open();
      await hold.promise;
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() }, tabId: 'tab-7' }, thread);
    await entered.promise;
    expect(framesOnEntry).toHaveLength(1);
    expect(framesOnEntry[0]).toBeGreaterThanOrEqual(1);
    // 第一帧就是 `submit` 返回的那一份：提交帧（提交队列之前推的）不是第二帧。
    expect(frames[0]).toBe(submitted.snapshot);
    expect(frames[0].state).toBe('running');
    expect(frames[0].counts.queued).toBe(2);
    expect(frames[0].search.map((item) => item.state)).toEqual(['queued', 'queued']);
    expect(frames[0].browserTabId).toBe('tab-7');
    expect(submitted.snapshot.counts.submissions).toBe(1);
    hold.open();
    await service.whenIdle(thread.threadId, submitted.researchRunId);
  });

  it('projects a progress event into its work item without keeping the row', async () => {
    const live = searchRow({
      status: 'partial',
      budgetUsage: usage({ distinctEntries: 12, scrolls: 4 }),
      sampleTruncation: { observed: 15, sampled: 12, omitted: 3 },
      networkPages: [pageFact()],
      networkPagesOmitted: 1,
    });
    const projected = gate();
    const hold = gate();
    const { service } = harness(async (work, ctx) => {
      ctx.onProgress({ section: 'search', rowIndex: 0, state: 'scrolling', row: live });
      projected.open();
      await hold.promise;
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() } }, thread);
    await projected.promise;
    // 采集循环还在改这一行：保留引用的话，下面两行会把卡片上的数字改掉。
    live.budgetUsage.distinctEntries = 99;
    live.sampleTruncation = { observed: 0, sampled: 0, omitted: 0 };
    const snapshot = await service.get(thread.threadId, submitted.researchRunId);
    expect(snapshot.search[0]).toMatchObject({
      state: 'scrolling', phaseDetail: null, posts: 12, omitted: 3, pages: 2, scrolls: 4,
      // 事件说它在按阶段推进，行就还没有结论：`status` 不许先写成采集层那个初始的 partial。
      status: null,
    });
    expect(snapshot.search[1].state).toBe('queued');
    hold.open();
    await service.whenIdle(thread.threadId, submitted.researchRunId);
  });

  it('keeps the read row phase detail from the progress event', async () => {
    const first = gate();
    const second = gate();
    const hold = gate();
    const { service } = harness(async (work, ctx) => {
      ctx.onProgress({ section: 'read', rowIndex: 0, state: 'collecting', phaseDetail: 'article', row: readRow() });
      first.open();
      await second.promise;
      ctx.onProgress({ section: 'read', rowIndex: 0, state: 'waiting', row: readRow() });
      hold.open();
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const submitted = await service.submit({ work: { read: readWork() } }, thread);
    await first.promise;
    expect((await service.get(thread.threadId, submitted.researchRunId)).read[0])
      .toMatchObject({ state: 'collecting', phaseDetail: 'article' });
    second.open();
    await hold.promise;
    // 事件说「没有子阶段」时就把子阶段清掉：它说的是这一行此刻的事实，不是一条只增不减的标签。
    expect((await service.get(thread.threadId, submitted.researchRunId)).read[0])
      .toMatchObject({ state: 'waiting', phaseDetail: null });
    await service.whenIdle(thread.threadId, submitted.researchRunId);
  });

  it('removes exactly the rejected submission from the index, not the last one', async () => {
    const store = new BlockingSubmissionStore();
    const { service } = harness(echoRunner, { store });
    const thread = owner();
    const settled = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, settled.researchRunId);
    // 第一份收尾提交先把研究建起来，接下来两份并发：A 的提交文件被闸住，B 抢在它后面提交。
    store.arm();
    const rejected = service.submit({ researchRunId: settled.researchRunId, work: { search: searchWork() } }, thread);
    await store.entered.promise;
    const second = await service.submit(
      { researchRunId: settled.researchRunId, work: { search: searchWork() } }, thread);
    store.release.open();
    await expect(rejected).rejects.toThrow('disk full');
    await service.whenIdle(thread.threadId, settled.researchRunId);
    // 索引必须与文件一致：A 的 id 被删掉，而排在它后面的 B 仍在（`pop()` 会删掉 B、留下 A）。
    const record = await store.readTask(thread.threadId, settled.researchRunId);
    expect(record?.submissionIds).toEqual([settled.submissionId, second.submissionId]);
    expect((await store.listSubmissions(thread.threadId, settled.researchRunId))
      .map((submission) => submission.submissionId).sort())
      .toEqual([settled.submissionId, second.submissionId].sort());
  });

  it('never repairs a run that is still live in this process', async () => {
    const entered = gate();
    const hold = gate();
    const { service } = harness(async (work, ctx) => {
      entered.open();
      await hold.promise;
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() } }, thread);
    await entered.promise;
    // 读一个正在飞的研究不是「上一个进程留下的进行中」：修复只能落在重启这个前提上。
    const live = await service.get(thread.threadId, submitted.researchRunId);
    expect(live.state).toBe('running');
    expect(live.stateReason).toBeUndefined();
    expect(live.counts).toMatchObject({ submissions: 1, queued: 2, interrupted: 0 });
    expect(live.search.map((item) => item.state)).toEqual(['queued', 'queued']);
    hold.open();
    await service.whenIdle(thread.threadId, submitted.researchRunId);
    // 而且修复不该在收尾时冒出：这一轮真的跑完了。
    expect((await service.get(thread.threadId, submitted.researchRunId)).state).toBe('completed');
  });

  it('writes the task record before the first submission file', async () => {
    const store = new RecordingStore(root());
    const { service } = harness(echoRunner, { store });
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, submitted.researchRunId);
    // 两次写之间被杀：只可能留下「索引比提交旧」的那一侧，不会出现「有提交、没有索引」的形状。
    expect(store.writeOrder.slice(0, 2)).toEqual(['task', 'submission']);
  });

  it('writes the finished row numbers and conclusion onto the work items', async () => {
    const { service, store } = harness(async (work) => ('search' in work
      ? searchResult([
        searchRow({
          status: 'partial', stopReason: 'budget_reached',
          budgetUsage: usage({ distinctEntries: 87, scrolls: 12, expandActions: 1 }),
          sampleTruncation: { observed: 99, sampled: 87, omitted: 12 },
          networkPages: [pageFact()], networkPagesOmitted: 2,
        }),
        searchRow({
          status: 'rate_limited', stopReason: 'access_barrier',
          barrier: { status: 'rate_limited', reason: 'http_status:429', observationId: null },
        }),
      ])
      : readResult([])));
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, submitted.researchRunId);
    const snapshot = await service.get(thread.threadId, submitted.researchRunId);
    expect(snapshot.search[0]).toMatchObject({
      label: 'Qwen3.8 27B', product: 'Top', state: 'stopped', status: 'partial',
      stopReason: 'budget_reached', posts: 87, omitted: 12, pages: 3, scrolls: 12,
      expandActions: 1, reason: null,
    });
    // 搜索行没有 `reason` 字段：失败原因只在 `barrier.reason` 里，卡片要显示的就是那句原话。
    expect(snapshot.search[1]).toMatchObject({
      label: 'Qwen3.8 27B Q4', product: 'Latest', state: 'stopped',
      status: 'rate_limited', reason: 'http_status:429',
    });
    expect(snapshot.state).toBe('failed');
    expect(snapshot.counts).toMatchObject({ done: 1, failed: 1, posts: 87 });
    expect(snapshot.usage).toEqual({ posts: 87, scrolls: 12, expandActions: 1 });
    const stored = await store.readSubmission(thread.threadId, submitted.researchRunId, submitted.submissionId);
    expect(stored).toMatchObject({
      state: 'done', endedAt: expect.any(String),
      usage: { posts: 87, scrolls: 12, expandActions: 1 },
    });
  });

  it('projects a finished read result into replies, root and article state', async () => {
    const { service, frames } = harness(async (work) => ('search' in work ? searchResult([]) : readResult([
      readRow({
        root: rootPost(),
        article: articleFacts({
          entryObserved: true,
          bodyObserved: true,
          body: articlePost('19581'),
        }),
        replies: replies([
          replyPost('9'),
          replyPost('10'),
        ]),
        budgetUsage: usage({ scrolls: 6, expandActions: 18 }),
      }),
      readRow({
        status: 'unavailable', stopReason: 'access_barrier', reason: 'http_status:403',
        barrier: { status: 'access_denied', reason: 'http_status:403', observationId: null },
        article: articleFacts({ barrier: { status: 'access_denied', reason: 'http_status:403', observationId: null } }),
      }),
    ])));
    const thread = owner();
    const submitted = await service.submit({ work: { read: readWork() } }, thread);
    // 提交帧里两行都是「文章待取」：请求声明过这项义务，不是估算。
    expect(frames[0].read.map((item) => item.article)).toEqual(['pending', 'pending']);
    await service.whenIdle(thread.threadId, submitted.researchRunId);
    const snapshot = await service.get(thread.threadId, submitted.researchRunId);
    expect(snapshot.read[0]).toMatchObject({
      state: 'stopped', status: 'observed', hasRoot: true, replies: 2, article: 'body',
      scrolls: 6, expandActions: 18, reason: null, posts: 0,
    });
    expect(snapshot.read[1]).toMatchObject({
      state: 'stopped', status: 'unavailable', hasRoot: false, replies: 0,
      article: 'failed', reason: 'http_status:403',
    });
    expect(snapshot.counts).toMatchObject({ replies: 2, articles: 1, posts: 0 });
  });

  it('marks the research interrupted when the work body throws and keeps the queue moving', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    const { service } = harness(async (work, ctx) => {
      calls += 1;
      if (calls === 1) throw new Error('artifact write failed');
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    // 异常被收在这里：日志是它唯一露面的地方（不带诊断 = 用户看到「中断」而没人知道原因）。
    expect(warn).toHaveBeenCalledWith('x_research', 'work body threw', expect.objectContaining({
      threadId: thread.threadId,
      researchRunId: first.researchRunId,
      submissionId: first.submissionId,
      err: 'Error: artifact write failed',
    }));
    warn.mockRestore();
    const failed = await service.get(thread.threadId, first.researchRunId);
    expect(failed.state).toBe('interrupted');
    // 没有结果就没有任何行结论：工作项停在 stopped、`status` 留空，投影把它算成「中断」，
    // 不把内部异常猜成「源拒绝」。
    expect(failed.search.map((item) => [item.state, item.status]))
      .toEqual([['stopped', null], ['stopped', null]]);
    expect(failed.counts.interrupted).toBe(2);
    // 一条链上的失败不许卡住后续提交。
    const second = await service.submit({ researchRunId: first.researchRunId, work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    const after = await service.get(thread.threadId, first.researchRunId);
    expect(after.counts).toMatchObject({ submissions: 2, done: 2, interrupted: 2 });
    expect(second.submissionId).not.toBe(first.submissionId);
  });

  it('never reports completed when a submission file cannot be read', async () => {
    const store = new XResearchTaskStore(root());
    const thread = owner();
    const researchRunId = randomUUID();
    const unreadable = randomUUID();
    // 盘上留着一条索引，指向一份读不出来的提交（崩溃/损坏之后的形状）。
    await store.writeTask({
      version: 1, researchRunId, threadId: thread.threadId, projectRoot: thread.projectRoot,
      createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:00.000Z',
      revision: 3, state: 'completed', submissionIds: [unreadable],
    });
    writeFileSync(path.join(store.taskDir(thread.threadId, researchRunId), `submission-${unreadable}.json`),
      '{ not json');
    const { service } = harness(echoRunner, { store });
    const submitted = await service.submit({ researchRunId, work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, researchRunId);
    const snapshot = await service.get(thread.threadId, researchRunId);
    // 读不出来的那份可能载着未收尾的工作：`xResearchTaskState([])` 落出的 `completed` 不是结论。
    expect(snapshot.state).toBe('interrupted');
    expect(snapshot.stateReason).toBe('submission_unreadable');
    expect(submitted.snapshot.state).toBe('interrupted');
    expect((await store.readTask(thread.threadId, researchRunId))?.state).toBe('interrupted');
  });

  it('keeps a cancellation when another submission file cannot be read', async () => {
    // 取消 + 一份读不出来的提交文件：`wait` 交付那份读得出来的时会落盘，而投影这一刻说
    // 「有一份提交读不出来」。那是**读盘缺口**，不是「为什么停了」的事实 —— 不许覆盖「被取消过」，
    // 否则重启后的 `submit` 认不出这段研究被停过，会直接往里追加。
    const dir = root();
    const artifactRef: XArtifactRef = {
      version: 1, directoryId: randomUUID(), manifest: 'manifest.json',
      sha256: 'a'.repeat(64), bytes: 10, runId: 'run-1', callId: 'call-submit',
      batchId: 'xbatch_1', operation: 'search',
    };
    const result = searchResult([searchRow({ query: searchWork().queries[0] })]);
    const writer = harness(async (work, ctx) => ({ ...(await echoRunner(work, ctx)), artifact: artifactRef }), {
      store: new XResearchTaskStore(dir),
    });
    const thread = owner();
    const cancelled = await writer.service.submit({ work: { search: searchWork() } }, thread);
    const control = await writer.service.submit({ work: { search: searchWork() } }, thread);
    await writer.service.whenIdle(thread.threadId, cancelled.researchRunId);

    const store = new XResearchTaskStore(dir);
    // 盘上的形状：索引里多一条读不出来的提交（崩溃 / 损坏之后的样子）。
    const breakOne = async (researchRunId: string, patch: Partial<XResearchTaskRecord>) => {
      const record = (await store.readTask(thread.threadId, researchRunId))!;
      const unreadable = randomUUID();
      await store.writeTask({ ...record, ...patch, submissionIds: [...record.submissionIds, unreadable] });
      writeFileSync(path.join(store.taskDir(thread.threadId, researchRunId), `submission-${unreadable}.json`),
        '{ not json');
    };
    await breakOne(cancelled.researchRunId, { state: 'cancelled', stateReason: 'cancelled' });
    // 对照（同一条用例里）：同样有一份读不出来的提交，但这段研究从来没被取消过。
    await breakOne(control.researchRunId, {});

    const artifacts: XResearchArtifactStore = {
      write: async () => { throw new Error('not used'); },
      displayPath: () => '/artifacts/manifest.json',
      locate: async () => '/artifacts/manifest.json',
      read: async () => structuredClone(result),
    };
    const next = harness(echoRunner, {
      store: new XResearchTaskStore(dir), artifacts: () => artifacts,
    });

    // 交付那份读得出来的：这一次落盘必须留下「被取消过」。
    const before = (await store.readTask(thread.threadId, cancelled.researchRunId))!;
    const delivered = await next.service.wait(thread.threadId, cancelled.researchRunId, 'wait-2');
    expect(delivered.deliveries).toHaveLength(1);
    // 盘上真的又被写过一次：`stateReason` 仍是 `cancelled` 不能只是因为没人碰过那份 fixture。
    // `wait` 的交付标记写在返回之后（spec §4.5），所以这一笔要等它落地。
    await vi.waitFor(async () => expect((await store.readTask(
      thread.threadId, cancelled.researchRunId))!.revision).toBeGreaterThan(before.revision));
    expect(delivered.snapshot.stateReason).toBe('cancelled');
    expect((await next.service.get(thread.threadId, cancelled.researchRunId)).stateReason).toBe('cancelled');
    expect((await store.readTask(thread.threadId, cancelled.researchRunId))?.stateReason).toBe('cancelled');

    // 重启之后照样不许追加：`submit` 认的就是这条理由。
    const rejected = await next.service.submit({
      researchRunId: cancelled.researchRunId, work: { search: searchWork() },
    }, thread).then(() => null, (error: unknown) => error);
    expect(rejected).toMatchObject({ code: 'research.cancelled' });

    // 翻面：从没被取消过的那段研究在同一刻落的是 `submission_unreadable`（上面那条不是「谁都留着」），
    // 而且它照样能追加 —— 拒绝的是「被取消过」这一段，不是所有带读盘缺口的研究。
    const controlDelivered = await next.service.wait(thread.threadId, control.researchRunId, 'wait-3');
    expect(controlDelivered.deliveries).toHaveLength(1);
    expect(controlDelivered.snapshot.stateReason).toBe('submission_unreadable');
    await next.service.submit({
      researchRunId: control.researchRunId, work: { search: searchWork() },
    }, thread);
    await next.service.whenIdle(thread.threadId, control.researchRunId);
  });

  it('delivers every finished submission of the run in one wait, in submission order', async () => {
    // R81c：一次 read 主题的提交 = 一份交付；三次 read 提交（三个目标）要能在**一次** `wait`
    // 里全部取回，而不是三次。`now` 每次前进一秒，提交顺序因此是确定的。
    let tick = 0;
    const { service, store } = harness(echoRunner, {
      now: () => new Date(Date.UTC(2026, 9, 16) + (tick++) * 1000).toISOString(),
    });
    const thread = owner();
    const submitted: Array<{ researchRunId: string; submissionId: string }> = [];
    for (const postId of ['101', '102', '103']) {
      submitted.push(await service.submit({
        ...(submitted.length ? { researchRunId: submitted[0]!.researchRunId } : {}),
        work: { read: readWork({ targets: [{ postId }] }) },
      }, thread));
    }
    await service.whenIdle(thread.threadId, submitted[0]!.researchRunId);

    const waited = await service.wait(thread.threadId, submitted[0]!.researchRunId, 'wait-1');
    expect(waited.deliveries.map((delivery) => delivery.submissionId))
      .toEqual(submitted.map((item) => item.submissionId));
    expect(waited.deliveries.every((delivery) => delivery.operation === 'read')).toBe(true);
    expect(waited.deliveries.map((delivery) => delivery.deliveryCallId))
      .toEqual(['wait-1', 'wait-1', 'wait-1']);
    expect(waited.undelivered).toEqual([]);
    expect(waited.snapshot.counts.undelivered).toBe(0);
    // `deliveredAt` / `deliveryCallId` 逐条落盘：这一批里每一条都是「这一轮交过了」。
    // 标记写在返回之后（spec §4.5），所以等它落地。
    await vi.waitFor(async () => {
      for (const item of submitted) {
        expect(await store.readSubmission(
          thread.threadId, item.researchRunId, item.submissionId)).toMatchObject({
          deliveredAt: expect.any(String), deliveryCallId: 'wait-1',
        });
      }
    });
    // 正控：没有一条被交第二遍。
    const again = await service.wait(thread.threadId, submitted[0]!.researchRunId, 'wait-2');
    expect(again.deliveries).toEqual([]);
    expect(again.undelivered).toEqual([]);
  });

  it('marks a submission interrupted when its result has fewer rows than work items', async () => {
    // 工作体少给一行 = 有一项没等到结论。快照不许因此落成「完成」：
    // `xResearchTaskState` 只看提交级的 `state`，所以这一层就得把话说准。
    const { service } = harness(async () => searchResult([
      searchRow({ budgetUsage: usage({ distinctEntries: 33, scrolls: 2 }) }),
    ]));
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, submitted.researchRunId);
    const snapshot = await service.get(thread.threadId, submitted.researchRunId);
    expect(snapshot.state).toBe('interrupted');
    expect(snapshot.counts).toMatchObject({ queued: 0, running: 0, done: 1, interrupted: 1, posts: 33 });
    expect(snapshot.search.map((item) => item.state)).toEqual(['stopped', 'stopped']);
  });

  it('refuses to wait on a research that is not on disk', async () => {
    const { service } = harness(echoRunner);
    await expect(service.whenIdle(randomUUID(), randomUUID()))
      .rejects.toThrow('X research task not found');
  });

  it('drains the post-return delivery write before the thread directory can be deleted', async () => {
    // 删对话的顺序是「拆除（排空）→ 删目录」（`threadService`）。交付标记写在 `wait` 返回之后
    // （spec §4.5），它不在那条尾链上 —— 排空不把它算进来的话，它会在目录被删之后把 `task.json`
    // 与 `submission-*.json` 写回来，一条已经删掉的研究重新长出来。
    const store = new DeliveryWriteProbeStore(root());
    const { service } = harness(echoRunner, { store });
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() } }, thread);
    const waited = await service.wait(thread.threadId, submitted.researchRunId, 'wait-1');
    expect(waited.deliveries[0]?.submissionId).toBe(submitted.submissionId);
    // 它确实还在飞：`wait` 已经返回，盘上还没有交付标记（否则下面的断言什么都证明不了）。
    expect(store.deliveryWritten).toBe(false);

    await service.disposeThread(thread.threadId);
    // 拆除返回之前那笔写必须已经落完 —— 下面这次删目录因此排在它之后。
    expect(store.deliveryWritten).toBe(true);
    await store.removeThread(thread.threadId);
    expect(existsSync(store.taskDir(thread.threadId, submitted.researchRunId))).toBe(false);
  });

  it('leaves a finished delivery unmarked when the turn stops before the mark', async () => {
    // 队列**已经空闲**：`awaitIdle` 当场返回，中止因此没有被「等链」接住。交付路径上还有两个真实
    // await —— 重启后首次 `open` 读盘、`deliverable` 读工件 —— 每一个都在写 `deliveredAt` 之前；
    // 中止落在那里时不复查就会「标了却没人接」。两处复查各用一段研究，一条红了不遮挡另一条。
    const dir = root();
    const artifactRef: XArtifactRef = {
      version: 1, directoryId: randomUUID(), manifest: 'manifest.json',
      sha256: 'a'.repeat(64), bytes: 10, runId: 'run-1', callId: 'call-submit',
      batchId: 'xbatch_1', operation: 'search',
    };
    const result = searchResult([searchRow({ query: searchWork().queries[0] })]);
    const writer = harness(async (work, ctx) => ({ ...(await echoRunner(work, ctx)), artifact: artifactRef }), {
      store: new XResearchTaskStore(dir),
    });
    const thread = owner();
    const earlyRun = await writer.service.submit({ work: { search: searchWork() } }, thread);
    const lateRun = await writer.service.submit({ work: { search: searchWork() } }, thread);
    await writer.service.whenIdle(thread.threadId, earlyRun.researchRunId);

    // 换一个进程：内存里没有结果，交付只能回到工件（R20）。
    const readEntered = gate();
    const readRelease = gate();
    const reads: string[] = [];
    let readGated = false;
    const artifacts: XResearchArtifactStore = {
      write: async () => { throw new Error('not used'); },
      displayPath: () => '/artifacts/manifest.json',
      locate: async () => '/artifacts/manifest.json',
      read: async (readRef) => {
        reads.push(readRef.callId);
        // 只有第二段闸住读工件；第一段要的是「读很快、中止照样得被接住」。
        if (!readGated) return structuredClone(result);
        readEntered.open();
        await readRelease.promise;
        return structuredClone(result);
      },
    };
    const openProcess = () => harness(echoRunner, {
      store: new XResearchTaskStore(dir), artifacts: () => artifacts,
    });
    const stored = new XResearchTaskStore(dir);

    // 1) 中止落在 `open` 读盘那一段：`awaitIdle` 之后的复查接住它。
    const early = new AbortController();
    const opened = openProcess().service
      .wait(thread.threadId, earlyRun.researchRunId, 'wait-1', early.signal)
      .then(() => 'resolved', (error: unknown) => `rejected:${String((error as { code?: unknown }).code)}`);
    early.abort();
    expect(await opened).toBe('rejected:agent.aborted');
    // 中止之后连工件都不该再读一次：这条复查就在 `awaitIdle` 之后，不是靠写 mark 之前那条兜住的。
    expect(reads).toEqual([]);
    expect((await stored.readSubmission(thread.threadId, earlyRun.researchRunId, earlyRun.submissionId))?.deliveredAt)
      .toBeUndefined();

    // 2) 中止落在 `deliverable` 读工件那一段：写 mark 之前的最后一次复查接住它。
    readGated = true;
    const lateProcess = openProcess();
    const late = new AbortController();
    const waiting = lateProcess.service
      .wait(thread.threadId, lateRun.researchRunId, 'wait-2', late.signal)
      .then(() => 'resolved', (error: unknown) => `rejected:${String((error as { code?: unknown }).code)}`);
    await readEntered.promise;
    late.abort();
    readRelease.open();
    expect(await waiting).toBe('rejected:agent.aborted');
    expect((await stored.readSubmission(thread.threadId, lateRun.researchRunId, lateRun.submissionId))?.deliveredAt)
      .toBeUndefined();
    const listed = await lateProcess.service.inspect(thread.threadId, lateRun.researchRunId, { view: 'deliveries' });
    expect(listed.items).toEqual([
      expect.objectContaining({ submissionId: lateRun.submissionId, deliveredAt: null, deliveryCallId: null }),
    ]);

    // 翻面：中止没有把这份结果吃掉，之后的 `wait` 照样交付一次。
    const delivered = await lateProcess.service.wait(thread.threadId, lateRun.researchRunId, 'wait-3');
    expect(delivered.deliveries[0]?.submissionId).toBe(lateRun.submissionId);
    expect(delivered.deliveries[0]?.deliveryCallId).toBe('wait-3');
    // 交付标记写在返回之后（spec §4.5）：等它落地，别把「还没写完」读成「没写」。
    await vi.waitFor(async () => expect((await stored.readSubmission(
      thread.threadId, lateRun.researchRunId, lateRun.submissionId))?.deliveredAt)
      .toEqual(expect.any(String)));
  });

  it('lists the thread runs newest first', async () => {
    let tick = 0;
    const now = (): string => new Date(Date.UTC(2026, 9, 16) + (tick++) * 1000).toISOString();
    const { service } = harness(echoRunner, { now });
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    const second = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, second.researchRunId);
    const listed = await service.list(thread.threadId);
    expect(listed.map((snapshot) => snapshot.researchRunId))
      .toEqual([second.researchRunId, first.researchRunId]);
  });

  it('orders two runs created in the same millisecond deterministically', async () => {
    const store = new XResearchTaskStore(root());
    const thread = owner();
    const createdAt = '2026-10-16T00:00:00.000Z';
    // 同一毫秒创建的两条：先后只能由第二个键定，否则两次 `list` 可以给出不同的列表。
    const older = '00000000-0000-4000-8000-000000000001';
    const newer = '00000000-0000-4000-8000-000000000002';
    for (const researchRunId of [older, newer]) {
      await store.writeTask({
        version: 1, researchRunId, threadId: thread.threadId, projectRoot: thread.projectRoot,
        createdAt, updatedAt: createdAt, revision: 0, state: 'completed', submissionIds: [],
      });
    }
    const { service } = harness(echoRunner, { store });
    const listed = await service.list(thread.threadId);
    expect(listed.map((snapshot) => snapshot.createdAt)).toEqual([createdAt, createdAt]);
    expect(listed.map((snapshot) => snapshot.researchRunId)).toEqual([newer, older]);
  });

  it('repairs a record left running on disk into an interrupted one', async () => {
    const dir = root();
    const store = new XResearchTaskStore(dir);
    const thread = owner();
    const createdAt = '2026-10-16T00:00:00.000Z';
    const researchRunId = randomUUID();
    const submission = storedSubmission({
      threadId: thread.threadId, researchRunId,
      // 被杀时的形状：一项还没开始、一项在飞。
      workItems: [workItem(), workItem({ state: 'scrolling', posts: 3, scrolls: 4 })],
    });
    await store.writeTask({
      version: 1, researchRunId, threadId: thread.threadId, projectRoot: thread.projectRoot,
      createdAt, updatedAt: createdAt, revision: 4, state: 'running',
      submissionIds: [submission.submissionId], browserTabId: 'tab-4',
    });
    await store.writeSubmission(submission);
    // 同一块盘上还有一条**已经收尾**的研究：修复只该落在「盘上写着进行中」的那条上。
    const settledRunId = randomUUID();
    const settledSubmission = storedSubmission({
      threadId: thread.threadId, researchRunId: settledRunId, state: 'done',
      endedAt: createdAt, workItems: [workItem({ state: 'stopped', status: 'observed' })],
    });
    await store.writeTask({
      version: 1, researchRunId: settledRunId, threadId: thread.threadId, projectRoot: thread.projectRoot,
      createdAt, updatedAt: createdAt, revision: 2, state: 'completed',
      submissionIds: [settledSubmission.submissionId],
    });
    await store.writeSubmission(settledSubmission);

    const { service, frames } = harness(echoRunner, { store });
    const repaired = await service.get(thread.threadId, researchRunId);
    // §4.4「崩溃后的诚实表示」：进程被杀后盘上的「进行中」不是最新状态，它是中断的残迹。
    expect(repaired.state).toBe('interrupted');
    expect(repaired.stateReason).toBe('process_restarted');
    expect(repaired.search.map((item) => [item.state, item.status]))
      .toEqual([['stopped', null], ['stopped', null]]);
    expect(repaired.browserTabId).toBe('tab-4');
    expect(frames.map((frame) => frame.state)).toEqual(['interrupted']);
    // 修复本身必须落盘：否则下一个进程重开时又会把它当成「进行中」。
    const disk = new XResearchTaskStore(dir);
    const persisted = await disk.readTask(thread.threadId, researchRunId);
    expect(persisted).toMatchObject({ state: 'interrupted', stateReason: repaired.stateReason });
    const persistedSubmission = await disk.readSubmission(thread.threadId, researchRunId, submission.submissionId);
    expect(persistedSubmission).toMatchObject({ state: 'interrupted', endedAt: expect.any(String) });
    // 已经收尾的那条原样读回：修复的判据是盘上的 `state`，不是「凡是读盘就改成中断」。
    const untouched = await service.get(thread.threadId, settledRunId);
    expect(untouched.state).toBe('completed');
    expect(untouched.stateReason).toBeUndefined();
  });

  it('repairs a run the crash left as completed with one submission still running', async () => {
    // `flush` 先写 `task.json`、后写提交文件（`wait` 的交付落盘就是这个顺序）：被杀在两次写之间，
    // 盘上就是「任务已完成 + 提交还在跑」。修复的判据是**提交**，不是 `record.state` —— 按后者判，
    // 这一份永远不会被修，而卡片按 `counts.queued + counts.running` 判「还有活」，于是一段做完了的
    // 研究在卡上带着一个能按的取消。
    const dir = root();
    const store = new XResearchTaskStore(dir);
    const thread = owner();
    const createdAt = '2026-10-16T00:00:00.000Z';
    const researchRunId = randomUUID();
    const submission = storedSubmission({
      threadId: thread.threadId, researchRunId,
      workItems: [workItem({ state: 'scrolling', posts: 3, scrolls: 4 })],
    });
    await store.writeTask({
      version: 1, researchRunId, threadId: thread.threadId, projectRoot: thread.projectRoot,
      createdAt, updatedAt: createdAt, revision: 7, state: 'completed',
      submissionIds: [submission.submissionId],
    });
    await store.writeSubmission(submission);

    // 同一块盘上还有一段**被取消过**的研究，崩溃落在 `cancel` 落盘的两个边界之间：`task.json` 已经
    // 带上 `stateReason: 'cancelled'`，排队的那份提交还没写成 `cancelled`。这条黏的事实不许被修复
    // 擦掉（R28）：收成 `interrupted` 就是说它是崩溃的残迹，而 `submit` 认的正是 `stateReason` ——
    // 工作会重新回到一段已取消的研究里。
    const cancelledRunId = randomUUID();
    const queuedSubmission = storedSubmission({
      threadId: thread.threadId, researchRunId: cancelledRunId, state: 'queued',
    });
    await store.writeTask({
      version: 1, researchRunId: cancelledRunId, threadId: thread.threadId, projectRoot: thread.projectRoot,
      createdAt, updatedAt: createdAt, revision: 9, state: 'running', stateReason: 'cancelled',
      submissionIds: [queuedSubmission.submissionId],
    });
    await store.writeSubmission(queuedSubmission);

    const { service } = harness(echoRunner, { store });
    const repaired = await service.get(thread.threadId, researchRunId);
    expect(repaired.state).toBe('interrupted');
    expect(repaired.stateReason).toBe('process_restarted');
    expect(repaired.counts).toMatchObject({ queued: 0, running: 0, interrupted: 1 });
    expect(repaired.search.map((item) => [item.state, item.status])).toEqual([['stopped', null]]);
    // 修复本身落盘：下一个进程重开时不能再把这一份读成「在跑」。
    const persisted = await new XResearchTaskStore(dir)
      .readSubmission(thread.threadId, researchRunId, submission.submissionId);
    expect(persisted).toMatchObject({ state: 'interrupted', endedAt: expect.any(String) });

    // 被取消过的那一段：残留的提交按**取消**收尾，快照说 `cancelled`，理由还在盘上。
    const cancelled = await service.get(thread.threadId, cancelledRunId);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.stateReason).toBe('cancelled');
    expect(cancelled.counts).toMatchObject({ queued: 0, running: 0, cancelled: 1 });
    expect(cancelled.search.map((item) => [item.state, item.status]))
      .toEqual([['stopped', 'cancelled']]);
    const reopened = new XResearchTaskStore(dir);
    expect(await reopened.readSubmission(thread.threadId, cancelledRunId, queuedSubmission.submissionId))
      .toMatchObject({ state: 'cancelled', endedAt: expect.any(String) });
    expect(await reopened.readTask(thread.threadId, cancelledRunId))
      .toMatchObject({ state: 'cancelled', stateReason: 'cancelled' });
    // 而且不许再往里追加工作：`submit` 认的就是这条理由。
    const rejected = await service.submit(
      { researchRunId: cancelledRunId, work: { search: searchWork() } }, thread)
      .then(() => null, (error: unknown) => error);
    expect(rejected).toMatchObject({ code: 'research.cancelled' });
  });

  it('does not keep a submission whose files never landed', async () => {
    const store = new FailingSubmissionStore(root());
    const { service } = harness(echoRunner, { store });
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    store.failWrites = true;
    // 写提交的那一刻失败：这次提交从没被排进队列，所以调用方拿到错误、内存里也不许留它。
    await expect(service.submit({ researchRunId: first.researchRunId, work: { read: readWork() } }, thread))
      .rejects.toThrow('disk full');
    const snapshot = await service.get(thread.threadId, first.researchRunId);
    expect(snapshot.counts.submissions).toBe(1);
    expect(snapshot.read).toHaveLength(0);
    // 盘上那一半也要撤回：索引说「有 2 份提交」而只有 1 个文件，是重启后才露面的静默错位。
    const persisted = await store.readTask(thread.threadId, first.researchRunId);
    expect(persisted?.submissionIds).toEqual([first.submissionId]);
    // 剩下的那份提交是收尾过的：孤儿提交不许把整段研究钉在「进行中」。
    expect(snapshot.state).toBe('completed');
    store.failWrites = false;
    const retried = await service.submit({ researchRunId: first.researchRunId, work: { read: readWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    expect(retried.researchRunId).toBe(first.researchRunId);
    expect((await service.get(thread.threadId, first.researchRunId)).counts.submissions).toBe(2);
  });
});

describe('XResearchTaskService inspect / cancel', () => {
  it('pages rows in submission order then work-item order without touching state', async () => {
    const { service } = harness(echoRunner);
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    const before = await service.get(thread.threadId, first.researchRunId);

    const page = await service.inspect(thread.threadId, first.researchRunId, { view: 'rows', pageSize: 1 });
    expect(page.items).toEqual([
      expect.objectContaining({ submissionId: first.submissionId, operation: 'search', index: 0 }),
    ]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const next = await service.inspect(thread.threadId, first.researchRunId, {
      view: 'rows', pageSize: 1, cursor: page.nextCursor,
    });
    expect(next.items).toEqual([expect.objectContaining({ submissionId: first.submissionId, index: 1 })]);
    expect(next.nextCursor).toBeUndefined();
    // inspect 只读：revision 与状态一个都没动（它读的就是快照背后的那批记录）。
    expect(await service.get(thread.threadId, first.researchRunId)).toEqual(before);

    // 页大小：缺省 20，上限 50。60 个工作项因此走两页。
    const wide = Array.from({ length: 60 }, (_, index) => ({
      id: `m${index}`, query: `query ${index}`, purpose: '看表现', product: 'Top' as const,
    }));
    await service.submit({ researchRunId: first.researchRunId, work: { search: searchWork({ queries: wide }) } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    expect((await service.inspect(thread.threadId, first.researchRunId, { view: 'rows' })).items).toHaveLength(20);
    const capped = await service.inspect(thread.threadId, first.researchRunId, { view: 'rows', pageSize: 999 });
    expect(capped.items).toHaveLength(50);
    expect(capped.nextCursor).toBeDefined();
    // 游标读不懂当场拒绝：静默从头发一页会让模型以为翻页成功了。
    await expect(service.inspect(thread.threadId, first.researchRunId, { view: 'rows', cursor: 'not-a-cursor' }))
      .rejects.toThrow('cursor');
  });

  it('reports the delivery authority of each submission', async () => {
    const artifact = {
      version: 1 as const, directoryId: 'dir-1', manifest: 'manifest.json' as const,
      sha256: 'a'.repeat(64), bytes: 10, runId: 'run-1', callId: 'call-1',
      batchId: 'xbatch_1', operation: 'search' as const,
    };
    let calls = 0;
    const { service } = harness(async (work, ctx) => {
      calls += 1;
      // 第三份没有结果可交付（工作体抛出）：它是「没交付」那一边的正面对照。
      if (calls === 3) throw new Error('no result');
      return calls === 1 ? echoRunner(work, ctx).then((result) => ({ ...result, artifact })) : echoRunner(work, ctx);
    });
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    await service.submit({ researchRunId: first.researchRunId, work: { search: searchWork() } }, thread);
    const third = await service.submit({ researchRunId: first.researchRunId, work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);

    const before = await service.inspect(thread.threadId, first.researchRunId, { view: 'deliveries' });
    expect(before.items).toEqual([
      expect.objectContaining({ submissionId: first.submissionId, deliveredAt: null, deliveryCallId: null, hasArtifact: true }),
      expect.objectContaining({ deliveredAt: null, deliveryCallId: null, hasArtifact: false }),
      expect.objectContaining({ submissionId: third.submissionId, deliveredAt: null, deliveryCallId: null }),
    ]);
    await service.wait(thread.threadId, first.researchRunId, 'wait-1');
    const after = await service.inspect(thread.threadId, first.researchRunId, { view: 'deliveries' });
    // 交付标记落在这一轮真交出去的两份上；没有结果的第三份仍是没交付（清单不猜「大概交过了」）。
    expect(after.items).toEqual([
      expect.objectContaining({ submissionId: first.submissionId, deliveredAt: expect.any(String), deliveryCallId: 'wait-1' }),
      expect.objectContaining({ deliveredAt: expect.any(String), deliveryCallId: 'wait-1' }),
      expect.objectContaining({ submissionId: third.submissionId, deliveredAt: null, deliveryCallId: null }),
    ]);
  });

  it('cancel on an idle research is a no-op and does not poison later submissions', async () => {
    const { service } = harness(echoRunner);
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    const before = await service.get(thread.threadId, first.researchRunId);
    // 带一个主语调空操作：返回的快照仍必须与调用前**逐字节相同** —— 有人按了取消但什么都没停，
    // 「谁取消的」也不能写上去（否则一段做完的研究会凭空多出一句「模型中途取消」）。
    const after = await service.cancel(thread.threadId, first.researchRunId, 'user');
    // 空操作：连 revision 都不动（动了就说明白写了一次盘、改了一次状态）。
    expect(after).toEqual(before);
    const second = await service.submit({ researchRunId: first.researchRunId, work: { read: readWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    expect((await service.get(thread.threadId, first.researchRunId)).counts.submissions).toBe(2);
    expect(second.researchRunId).toBe(first.researchRunId);
  });

  it('cancel does not wait for another research on the same thread', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const firstStarted = gate();
    const secondGate = gate();
    let calls = 0;
    const { service } = harness(async (work, ctx) => {
      calls += 1;
      if (calls === 1) {
        firstStarted.open();
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')));
        });
      } else await secondGate.promise;
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    await firstStarted.promise;
    // 同一 thread 上的第二段研究排在它后面：cancel 等的是第一段**自己**在飞的那一份，
    // 不是整条 thread 链（等链 = 点一下取消就要等另一段研究的采集跑完）。
    const second = await service.submit({ work: { search: searchWork() } }, thread);
    const outcome = await Promise.race([
      service.cancel(thread.threadId, first.researchRunId).then(() => 'returned'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 500)),
    ]);
    expect(outcome).toBe('returned');
    expect((await service.get(thread.threadId, first.researchRunId)).state).toBe('cancelled');
    // 翻面：被等的是「那段研究」，不是「这个 thread」—— 第二段研究照旧跑完。
    expect(second.researchRunId).not.toBe(first.researchRunId);
    secondGate.open();
    await service.whenIdle(thread.threadId, second.researchRunId);
    expect((await service.get(thread.threadId, second.researchRunId)).state).toBe('completed');
  });

  it('concludes a cancelled research as cancelled even though the collector returns a result instead of throwing', async () => {
    // 采集层的取消形状是**返回**一份结果：`browser.cancelled` 被映成 `status: 'cancelled'` 的行
    // （`xResearchSearch` 的 `failure` / `xResearchRead` 的 `halt`），不是抛错。只看行数的收尾会把它
    // 当成 `done` —— 一段用户刚取消的研究于是读成「完成（部分被取消）」，`cancelSubmission` 又因为
    // 提交已经不是 queued/running 而早退，谁都不改它。
    const started = gate();
    const { service, store } = harness(async (work, ctx) => {
      started.open();
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return searchResult([
        // 取消之前已经收尾的那一行保住它的结论与数字（§4.7）。
        searchRow({ query: searchWork().queries[0]!, budgetUsage: usage({ distinctEntries: 12 }) }),
        searchRow({
          query: searchWork().queries[1]!, status: 'cancelled', stopReason: 'cancelled',
        }),
      ]);
    });
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() } }, thread);
    await started.promise;
    const snapshot = await service.cancel(thread.threadId, submitted.researchRunId);
    expect(snapshot.state).toBe('cancelled');
    // 桶按行结论分：取消之前收尾的那一行在 done 里，取消的那一行才在 cancelled 里。
    expect(snapshot.counts).toMatchObject({ submissions: 1, done: 1, cancelled: 1, queued: 0, running: 0 });
    expect(snapshot.search.map((row) => [row.state, row.status, row.posts])).toEqual([
      ['stopped', 'observed', 12],
      ['stopped', 'cancelled', 0],
    ]);
    expect((await store.readTask(thread.threadId, submitted.researchRunId))?.state).toBe('cancelled');
    expect((await store.listSubmissions(thread.threadId, submitted.researchRunId))
      .map((submission) => submission.state)).toEqual(['cancelled']);
  });

  it('cancel flushes the cancellation to disk before it answers', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const dir = root();
    const store = new XResearchTaskStore(dir);
    const started = gate();
    const { service } = harness(async (work, ctx) => {
      started.open();
      // 采集层照 `ctx.signal` 收尾：cancel 之后当场拒绝。
      await new Promise<void>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')));
      });
      return echoRunner(work, ctx);
    }, { store });
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() } }, thread);
    await started.promise;
    const snapshot = await service.cancel(thread.threadId, submitted.researchRunId);
    expect(snapshot.state).toBe('cancelled');
    // 换一个 store 实例读同一块盘：返回时盘上已经是取消后的样子（R12：先 flush 再返回）。
    const persisted = await new XResearchTaskStore(dir).readTask(thread.threadId, submitted.researchRunId);
    expect(persisted).toMatchObject({ state: 'cancelled', stateReason: 'cancelled' });
  });

  it('keeps who cancelled on disk, so a restart still says who stopped it', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const dir = root();
    const started = gate();
    const { service } = harness(async (work, ctx) => {
      started.open();
      // 采集层照 `ctx.signal` 收尾（取消之后它返回一份结果，不抛）。
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) resolve();
        else ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return echoRunner(work, ctx);
    }, { store: new XResearchTaskStore(dir) });
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() } }, thread);
    await started.promise;
    const snapshot = await service.cancel(thread.threadId, submitted.researchRunId, 'agent');
    expect(snapshot.cancelledBy).toBe('agent');
    // 主语随取消一起落盘：换 store、换 service 实例（= 重启）读回来的还是同一个主语。
    expect(await new XResearchTaskStore(dir).readTask(thread.threadId, submitted.researchRunId))
      .toMatchObject({ stateReason: 'cancelled', cancelledBy: 'agent' });
    const reopened = harness(echoRunner, { store: new XResearchTaskStore(dir) });
    expect((await reopened.service.get(thread.threadId, submitted.researchRunId)).cancelledBy)
      .toBe('agent');
  });

  it('settles every queued submission at once, on the returned snapshot and on disk', async () => {
    // 两个研究在同一 thread：第一段把整条链占住，于是第二段的两次提交**一份都没在跑**。
    // 这条钉的是 `cancel` 里那段「把排队中的提交当场写成 cancelled」的循环：没有它，链上的 `run`
    // 闸要到链推进时才补上同一个结果，取消返回的快照（以及它落盘的那份）会停在 `queued`。
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const dir = root();
    const store = new XResearchTaskStore(dir);
    const blockerStarted = gate();
    const blockerRelease = gate();
    const { service } = harness(async (work, ctx) => {
      blockerStarted.open();
      await blockerRelease.promise;
      return echoRunner(work, ctx);
    }, { store });
    const thread = owner();
    const blocker = await service.submit({ work: { search: searchWork() } }, thread);
    await blockerStarted.promise;
    const queued = await service.submit({ work: { search: searchWork() } }, thread);
    await service.submit({ researchRunId: queued.researchRunId, work: { search: searchWork() } }, thread);

    const cancelled = await service.cancel(thread.threadId, queued.researchRunId);
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.stateReason).toBe('cancelled');
    // 两次提交 × 两个 query：每一行都是取消收尾，没有一行停在 queued。
    expect(cancelled.counts).toMatchObject({ submissions: 2, cancelled: 4, queued: 0, running: 0 });
    expect([...cancelled.search, ...cancelled.read].map((item) => [item.state, item.status, item.stopReason]))
      .toEqual(Array.from({ length: 4 }, () => ['stopped', 'cancelled', 'cancelled']));
    // 换一个 store 实例读同一块盘：返回时盘上已经是取消后的样子（R12）。
    const fresh = new XResearchTaskStore(dir);
    expect(await fresh.readTask(thread.threadId, queued.researchRunId))
      .toMatchObject({ state: 'cancelled', stateReason: 'cancelled' });
    const persisted = await fresh.listSubmissions(thread.threadId, queued.researchRunId);
    expect(persisted.map((submission) => submission.state)).toEqual(['cancelled', 'cancelled']);
    expect(persisted.flatMap((submission) => submission.workItems.map((item) => item.status)))
      .toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);

    // 翻面：被取消的只是那段研究 —— 占着链的第一段照旧跑完（取消只拦它自己那一段）。
    blockerRelease.open();
    await service.whenIdle(thread.threadId, blocker.researchRunId);
    expect((await service.get(thread.threadId, blocker.researchRunId)).state).toBe('completed');
  });
});

describe('registerXResearchTaskService：进程级实例只许有一个', () => {
  afterEach(() => { registerXResearchTaskService(undefined); });

  /** 登记缝只比身份：这两个假实例从不被调用，构造整台 service 只会把判据埋进无关依赖里。 */
  function token(label: string): XResearchTaskService {
    return { label } as unknown as XResearchTaskService;
  }

  it('同一实例重复登记无害，第二个不同的实例当场抛 research.conflict', () => {
    const first = token('first');
    const second = token('second');
    registerXResearchTaskService(first);
    // 正控：同一条路、同一个实例再来一次不抛。下面那句的抛出因此来自「换了一个实例」。
    expect(() => registerXResearchTaskService(first)).not.toThrow();
    expect(xResearchTaskService()).toBe(first);
    expect(() => registerXResearchTaskService(second)).toThrow(expect.objectContaining({ code: 'research.conflict' }));
    // 拒绝发生在改状态之前：抛了之后登记的仍是原来那一个，不会留下「抛了但换了一半」。
    expect(xResearchTaskService()).toBe(first);
  });

  it('中间夹一次 undefined 的重接线是允许的（T9 的 dispose / 重建走这条路）', () => {
    const first = token('first');
    const second = token('second');
    registerXResearchTaskService(first);
    registerXResearchTaskService(undefined);
    expect(xResearchTaskService()).toBeNull();
    expect(() => registerXResearchTaskService(second)).not.toThrow();
    expect(xResearchTaskService()).toBe(second);
  });
});
