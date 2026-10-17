import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { XResearchSubmission, XResearchTaskRecord, XResearchTaskSnapshot } from '../../shared/xResearchTask';
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
    const { service } = harness(echoRunner);
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    const second = await service.submit({ researchRunId: first.researchRunId, work: { read: readWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
    expect(second.researchRunId).toBe(first.researchRunId);
    const snapshot = await service.get(thread.threadId, first.researchRunId);
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

  it('emits a snapshot on submit before any work runs', async () => {
    const hold = gate();
    const { service, frames } = harness(async (work, ctx) => {
      await hold.promise;
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const submitted = await service.submit({ work: { search: searchWork() }, tabId: 'tab-7' }, thread);
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
    let calls = 0;
    const { service } = harness(async (work, ctx) => {
      calls += 1;
      if (calls === 1) throw new Error('artifact write failed');
      return echoRunner(work, ctx);
    });
    const thread = owner();
    const first = await service.submit({ work: { search: searchWork() } }, thread);
    await service.whenIdle(thread.threadId, first.researchRunId);
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
});
