import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KydogError } from '../../shared/errors';
import { fixture, post, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import { finalizeXResearchCollection } from './xResearchCanonical';
import type { XResearchArtifactStore } from './xResearchArtifacts';
import type { XResearchTaskSnapshot } from '../../shared/xResearchTask';
import { XResearchTaskService } from './xResearchTaskService';
import { XResearchTaskStore } from './xResearchTaskStore';
import { serializeXResearchResult } from './xResearchOutput';
import { searchResult, searchX } from './xResearchSearch';
import { XResearchScopeLedger } from './xResearchScopeFacts';
import type { XResearchProgressEvent, XResearchWorkContext } from './xResearchTaskService';
import { createXResearchRunner } from './xResearchRunner';
import type { XReadRequest, XResearchResult } from './xResearchTypes';

// 两次收集各自生成观察 id，逐字节比对因此需要确定性：id 只在这里被固定（长度与 v4 格式不变，
// 于是两边真的逐字节可比，而不是「把 id 抹掉后看起来一样」）。
const ids = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => {
      ids.n += 1;
      return `00000000-0000-4000-8000-${String(ids.n).padStart(12, '0')}`;
    },
  };
});

const RESEARCH_RUN = '11111111-1111-4111-8111-111111111111';
const SUBMISSION = '22222222-2222-4222-8222-222222222222';
const RUN_ID = 'run-of-submit';
const SUBMIT_CALL_ID = 'call-of-submit';
const BATCH_ID = 'xbatch_of_submit';
const target = 'https://x.com/alice/status/123';

const readWork: XReadRequest = {
  objective: 'read', targets: [{ url: target }],
  includeArticle: false, includeReplies: false,
  maxRepliesPerPost: 0, maxScrollsPerPost: 0, maxExpandActionsPerPost: 0,
};

/** 一次提交的工作上下文：标签页的读写落在闭包里，于是用例看得见任务记住了什么。 */
function harness(overrides: Partial<XResearchWorkContext> = {}) {
  let tab: string | undefined;
  const ctx: XResearchWorkContext = {
    threadId: 'thread',
    researchRunId: RESEARCH_RUN,
    submissionId: SUBMISSION,
    batchId: BATCH_ID,
    runId: RUN_ID,
    submitCallId: SUBMIT_CALL_ID,
    signal: new AbortController().signal,
    tabBinding: { get: () => tab, set: (tabId) => { tab = tabId; } },
    onProgress: () => undefined,
    ...overrides,
  };
  return { ctx, tab: () => tab, bind: (tabId?: string) => { tab = tabId; } };
}

type DepsOptions = {
  tabStatus?: () => 'available' | 'foreign' | 'missing';
  artifacts?: XResearchArtifactStore;
  askedPriors?: string[];
  ledger?: XResearchScopeLedger;
};

function depsFor(f: ReturnType<typeof fixture>, options: DepsOptions = {}) {
  const ledger = options.ledger ?? new XResearchScopeLedger();
  const browser = options.tabStatus
    ? { ...f.context.browser, tabStatus: options.tabStatus }
    : f.context.browser;
  return {
    browserFor: () => browser,
    contextFor: () => ({
      sources: f.context.sources,
      currentRunId: () => RUN_ID,
      scopePrior: (runId: string) => {
        options.askedPriors?.push(runId);
        return ledger.prior(runId);
      },
    }),
    artifacts: () => options.artifacts ?? tempXArtifactStore(),
  };
}

function rowsOf(result: XResearchResult) {
  return result.operation === 'search' ? result.queries : result.targets;
}

function searchRows(result: XResearchResult) {
  if (result.operation !== 'search') throw new Error('search expected');
  return result.queries;
}

function conclusionOf(row: ReturnType<typeof rowsOf>[number]) {
  return {
    status: row.status,
    stopReason: row.stopReason,
    reason: 'reason' in row ? row.reason : row.barrier?.reason ?? null,
  };
}

describe('x research runner', () => {
  it('carries the submit-run scope prior into the serialized result', async () => {
    const f = fixture([searchHtml(post())]);
    const askedPriors: string[] = [];
    const runner = createXResearchRunner(depsFor(f, { askedPriors }));
    const result = await runner({ search: searchInput.search }, harness().ctx);
    // prior 取的是**提交那一轮**的 runId：采集层的 runId 与它不同，`withCurrent` 会当场抛。
    expect(askedPriors).toEqual([RUN_ID]);
    expect(result.runId).toBe(RUN_ID);
    // 结果里的 callId 就是提交的 callId，任务壳恢复时据此把结果与提交对上（Task 7）。
    expect(result.callId).toBe(SUBMIT_CALL_ID);
    // 结果形状（旧 `details` 的那几项）：schemaVersion 仍在、operation 与行数对得上。
    expect(result).toMatchObject({ schemaVersion: 2, operation: 'search' });
    expect(result.reportScopeFacts).toMatchObject({ totalRows: 1 });
    expect(result.reportRunScopeFacts).toEqual({
      version: 1, runId: RUN_ID, callCount: 1, unavailableCallCount: 0,
      search: expect.objectContaining({ totalRows: 1, statusCounts: { partial: 1 } }),
      read: expect.objectContaining({ totalRows: 0 }),
    });
    // 翻面：换一个 runId，prior 与结果都跟着换（不是某一处写死的常量）。
    const nextResult = await runner(
      { search: searchInput.search }, harness({ runId: 'run-of-next-turn' }).ctx);
    expect(askedPriors).toEqual([RUN_ID, 'run-of-next-turn']);
    expect(nextResult.reportRunScopeFacts?.runId).toBe('run-of-next-turn');
  });

  it('marks every row failed when the tab is gone before the work starts', async () => {
    const f = fixture([searchHtml(post())]);
    let status: 'available' | 'foreign' | 'missing' = 'missing';
    const runner = createXResearchRunner(depsFor(f, { tabStatus: () => status }));
    const gone = harness();
    gone.bind('gone-tab');
    const failed = await runner({ search: searchInput.search }, gone.ctx);
    expect(failed.status).toBe('failed');
    for (const row of searchRows(failed)) {
      expect(row).toMatchObject({
        status: 'failed', stopReason: 'navigation_failed',
        barrier: { status: 'failed', reason: 'navigation_failed:browser.no_tab', observationId: null },
      });
    }
    // 注册表缺席发生在这轮第一次导航之前：不重放一次注定失败的尝试。
    expect(f.open).not.toHaveBeenCalled();
    // 任务忘掉这个标签页，下一个提交自己开一个。
    expect(gone.tab()).toBeUndefined();
    // 翻面：标签页还在时同样的输入照常采集 —— 上面那条「没导航」才不是「什么也没跑」。
    // 同一个任务上下文**再提交一次**：死标签页已经忘了，这一轮自己开一个。
    status = 'available';
    const collected = await runner({ search: searchInput.search }, gone.ctx);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.open.mock.calls[0][1]).toBeUndefined();
    expect(searchRows(collected)[0].status).not.toBe('failed');
    // 新开的标签页被任务记住，下一轮直接复用它。
    expect(gone.tab()).toBe('research-tab');
    await runner({ search: searchInput.search }, gone.ctx);
    expect(f.open.mock.calls[1][1]).toBe('research-tab');
  });

  it('fills collectionStop for every row before delivering', async () => {
    const f = fixture([readHtml(post())]);
    // 前提：前置失败的裸形状里根本没有 collectionStop —— 下面那些断言只能来自补齐。
    const bare = searchResult({ search: searchInput.search }, {
      browser: f.context.browser, threadId: 'thread', sources: f.context.sources,
      runId: RUN_ID, callId: SUBMIT_CALL_ID, batchId: BATCH_ID,
    });
    expect(bare.queries[0].collectionStop).toBeUndefined();
    const gone = () => createXResearchRunner(depsFor(f, { tabStatus: () => 'missing' }));
    const deadTab = () => { const submitted = harness(); submitted.bind('gone-tab'); return submitted; };
    const searched = await gone()({ search: searchInput.search }, deadTab().ctx);
    const read = await gone()({ read: readWork }, deadTab().ctx);
    for (const result of [searched, read]) {
      const rows = rowsOf(result);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.stopReason === 'navigation_failed')).toBe(true);
      for (const row of rows) expect(row.collectionStop).toEqual(conclusionOf(row));
    }
    // 翻面：采集层自己写的 collectionStop 原样留着（补齐不是覆盖）。
    const alive = fixture([searchHtml(post())]);
    const collected = await createXResearchRunner(depsFor(alive))(
      { search: searchInput.search }, harness().ctx);
    expect(searchRows(collected)[0].collectionStop).toEqual(conclusionOf(searchRows(collected)[0]));
  });

  it('keeps the collected result byte-identical to a direct searchX call', async () => {
    const viaRunner = fixture([searchHtml(post())]);
    const direct = fixture([searchHtml(post())]);
    const artifacts = tempXArtifactStore();
    const ledger = new XResearchScopeLedger();
    const progress: XResearchProgressEvent[] = [];
    const runner = createXResearchRunner(depsFor(viaRunner, { artifacts, ledger }));
    ids.n = 0;
    const result = await runner({ search: searchInput.search },
      harness({ onProgress: (event) => progress.push({ ...event }) }).ctx);
    // 进度真的报了（否则「没改结果」只是「什么也没跑」）。
    expect(progress[0]).toMatchObject({ section: 'search', rowIndex: 0, state: 'navigating' });
    expect(progress.some((event) => event.state === 'collecting')).toBe(true);
    expect(progress.every((event) => event.row !== undefined)).toBe(true);
    // 直接调采集层：同一夹具、同一 id 序列、走旧 execute 的同一段后处理。
    ids.n = 0;
    const collected = await searchX(searchInput, {
      browser: direct.context.browser, threadId: 'thread', sources: direct.context.sources,
      runId: RUN_ID, callId: SUBMIT_CALL_ID, batchId: BATCH_ID,
    });
    for (const row of rowsOf(collected)) row.collectionStop ??= conclusionOf(row);
    const expected = finalizeXResearchCollection(collected);
    expected.artifact = result.artifact!;
    expected.delivery = {
      truncated: false, omittedObservations: 0, omittedFields: [],
      artifactPath: artifacts.displayPath(result.artifact!), persistence: 'saved',
    };
    const serialized = serializeXResearchResult(expected, ledger.prior(RUN_ID));
    expect(JSON.stringify(result)).toBe(JSON.stringify(serialized.result));
  });

  it('passes the submit budget policy to the collectors instead of re-deriving it', async () => {
    const f = fixture([searchHtml(post())]);
    const runner = createXResearchRunner(depsFor(f));
    // 省略的预算在旧工具里记成 'default'。工作请求不带上来源，采集层只能把每一维都说成
    // 'explicit' —— 那是一句关于请求的假话，所以来源必须从这里传下去。
    const defaulted = await runner({
      search: searchInput.search,
      budgetPolicy: { posts: { limit: 1, origin: 'default' }, scrolls: { limit: 0, origin: 'default' } },
    }, harness().ctx);
    expect(searchRows(defaulted)[0].budgetBinding)
      .toContainEqual({ dimension: 'posts', limit: 1, origin: 'default', used: 1 });
    expect(searchRows(defaulted)[0].budgetBinding?.every((binding) => binding.origin === 'default'))
      .toBe(true);
    // 翻面：同样的上限、只是来源不同 → 标签跟着提交走。
    const explicit = await runner({
      search: searchInput.search,
      budgetPolicy: { posts: { limit: 1, origin: 'explicit' }, scrolls: { limit: 0, origin: 'explicit' } },
    }, harness().ctx);
    expect(searchRows(explicit)[0].budgetBinding)
      .toContainEqual({ dimension: 'posts', limit: 1, origin: 'explicit', used: 1 });
  });

  it('rejects a tab owned by another thread and lets a read open its own', async () => {
    const f = fixture([readHtml(post())]);
    let status: 'available' | 'foreign' | 'missing' = 'foreign';
    const runner = createXResearchRunner(depsFor(f, { tabStatus: () => status }));
    const foreign = harness();
    foreign.bind('other-thread-tab');
    await expect(runner({ read: readWork }, foreign.ctx)).rejects.toThrow('another thread');
    expect(f.open).not.toHaveBeenCalled();
    // 翻面：标签页只是还没被任务记住时，read 自己开一个（不是前置失败，也不是猜一个 id）
    status = 'available';
    const fresh = harness();
    const read = await runner({ read: readWork }, fresh.ctx);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(read.operation === 'read' && read.targets[0].root?.postId).toBe('123');
  });

  it('forgets the task tab only after the live registry proves it gone', async () => {
    const f = fixture([searchHtml(post())]);
    let present = true;
    const runner = createXResearchRunner(depsFor(f, {
      tabStatus: () => (present ? 'available' : 'missing'),
    }));
    const submitted = harness();
    submitted.bind('research-tab');
    await runner({ search: searchInput.search }, submitted.ctx);
    expect(submitted.tab()).toBe('research-tab');
    // 一次动作把标签页弄没了：这一轮仍然报出真导航过的那个 id，任务随即忘掉它
    f.act.mockImplementationOnce(async () => {
      present = false;
      throw new KydogError('browser.not_dispatchable', 'target destroyed');
    });
    const lost = await runner({ search: searchInput.search }, submitted.ctx);
    expect(lost.browserTabId).toBe('research-tab');
    expect(submitted.tab()).toBeUndefined();
    // 下一轮自己开一个，而不是重放那张已经不存在的标签页
    present = true;
    await runner({ search: searchInput.search }, submitted.ctx);
    expect(f.open.mock.calls.at(-1)![1]).toBeUndefined();
  });

  it('still delivers the collected result when the artifact cannot be written', async () => {
    const f = fixture([searchHtml(post())]);
    const artifacts: XResearchArtifactStore = {
      write: async () => { throw new Error('disk full'); },
      read: async () => { throw new Error('unused'); },
      displayPath: () => 'unused',
    };
    const result = await createXResearchRunner(depsFor(f, { artifacts }))(
      { search: searchInput.search }, harness().ctx);
    // 落盘失败不改变「读到了什么」，只是没有可解析的工件引用
    expect(result.artifact).toBeUndefined();
    expect(result.delivery).toMatchObject({
      persistence: 'failed', artifactPath: null, failureCode: 'write',
    });
    expect(searchRows(result)[0].posts).toHaveLength(1);
    // 翻面：落盘成功时同一份结果带着可解析的工件引用。
    const saved = await createXResearchRunner(depsFor(f))(
      { search: searchInput.search }, harness().ctx);
    expect(saved.artifact).toBeDefined();
    expect(saved.delivery).toMatchObject({ persistence: 'saved' });
    expect(searchRows(saved)[0].posts).toHaveLength(1);
  });

  it('reports live row numbers to the task while the work is still running', async () => {
    const f = fixture([searchHtml(post())]);
    const root = mkdtempSync(path.join(os.tmpdir(), 'x-runner-progress-'));
    // 推出去的那一帧与内存里是同一批工作项对象（渲染层靠 IPC 克隆），所以在收到的当下抄数字。
    const frames: Array<{ state?: string; posts?: number; status?: string | null }> = [];
    const service = new XResearchTaskService({
      store: new XResearchTaskStore(root),
      runWork: createXResearchRunner(depsFor(f)),
      onUpdate: (snapshot: XResearchTaskSnapshot) => frames.push({
        state: snapshot.search[0]?.state, posts: snapshot.search[0]?.posts,
        status: snapshot.search[0]?.status,
      }),
    });
    try {
      const submitted = await service.submit({ work: { search: searchInput.search } },
        { threadId: '33333333-3333-4333-8333-333333333333', runId: RUN_ID, projectRoot: '/p' });
      await service.whenIdle('33333333-3333-4333-8333-333333333333', submitted.researchRunId);
      // 还在跑的中间帧里已经有真实帖数：卡片上的「运行中」不是空壳。
      expect(frames.some((frame) => frame.state === 'navigating')).toBe(true);
      // 行还没收尾（status === null）就已经带着真实帖数 —— 这正是「运行中」那一帧的事实。
      expect(frames.some((frame) => frame.state === 'collecting'
        && frame.posts === 1 && frame.status === null)).toBe(true);
      expect(frames.at(-1)).toMatchObject({ state: 'stopped', status: 'partial', posts: 1 });
      // 收尾之后数字不变（进度没有把结论写歪）。
      const final = await service.get('33333333-3333-4333-8333-333333333333', submitted.researchRunId);
      expect(final.search[0]).toMatchObject({ posts: 1, status: 'partial', state: 'stopped' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never lets a progress observer change the collection result', async () => {
    const f = fixture([searchHtml(post())]);
    const result = await createXResearchRunner(depsFor(f))({ search: searchInput.search },
      harness({ onProgress: () => { throw new Error('observer failure'); } }).ctx);
    expect(searchRows(result)[0].posts).toHaveLength(1);
    expect(f.open).toHaveBeenCalledTimes(1);
  });
});
