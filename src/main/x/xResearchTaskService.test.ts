import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  XResearchSubmission, XResearchTaskRecord, XResearchTaskSnapshot, XResearchWorkItem,
} from '../../shared/xResearchTask';
import { logger } from '../log';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import type { XNetworkPageFact } from './xNetworkLease';
import { XResearchTaskStore } from './xResearchTaskStore';
import { XResearchTaskService, type XResearchRunWork } from './xResearchTaskService';
import type {
  XArticleFacts, XReadObservation, XReadRequest, XResearchResult, XSearchObservation,
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

function harness(runWork: XResearchRunWork, options: { store?: XResearchTaskStore; now?: () => string } = {}) {
  const store = options.store ?? new XResearchTaskStore(root());
  const frames: XResearchTaskSnapshot[] = [];
  const service = new XResearchTaskService({
    store, runWork, onUpdate: (snapshot) => frames.push(snapshot),
    // 这些用例不碰交付的工件路径（`wait` 的回归在 `xResearchDeliver.test.ts`）：给一个空根即可。
    artifacts: () => tempXArtifactStore(),
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
