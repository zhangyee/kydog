import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KydogError } from '../../shared/errors';
import { logger } from '../log';
import { fixture, post, query, readHtml, searchHtml, searchInput } from '../../test-support/xResearchFixture';
import { tempXArtifactStore } from '../../test-support/xArtifactStore';
import { finalizeXResearchCollection } from './xResearchCanonical';
import type { XResearchArtifactStore } from './xResearchArtifacts';
import type { XResearchTaskSnapshot } from '../../shared/xResearchTask';
import { XResearchTaskService } from './xResearchTaskService';
import { XResearchTaskStore } from './xResearchTaskStore';
import { serializeXResearchResult } from './xResearchOutput';
import { searchX } from './xResearchSearch';
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
  /** 接收要问的那张页：替身得能只把死掉的那一张报成 `missing`（否则「活注册表才分得清」那道闸
   *  会把这一轮刚开的新页也判成死页，测试于是考的就不是重试了）。 */
  tabStatus?: (tabId: string) => 'available' | 'foreign' | 'missing';
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

/** 每一帧的分子按序去重：留下的是「收盘一格一格涨」的形状，重复的帧不影响它。 */
function successiveValues(values: number[]): number[] {
  return values.filter((value, index) => index === 0 || value !== values[index - 1]);
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

  it('recovers a dead bound tab with one retry and rebinds the tab it opened', async () => {
    const f = fixture([searchHtml(post())]);
    let status: 'available' | 'foreign' | 'missing' = 'missing';
    const runner = createXResearchRunner(depsFor(f, {
      tabStatus: (tabId) => (status === 'missing' && tabId === 'gone-tab' ? 'missing' : 'available'),
    }));
    const gone = harness();
    gone.bind('gone-tab');
    const collected = await runner({ search: searchInput.search }, gone.ctx);
    // 绑定的页在这一轮开始前就没了：忘掉它、用新页跑**一次**（R81f）。第一轮一次浏览器都没碰，
    // 所以这一次重试只重做那些证明什么都没产出的工作。不恢复的话整批全灭 —— 现场 13 行全失败。
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.open.mock.calls[0][1]).toBeUndefined();
    expect(searchRows(collected)[0].status).not.toBe('failed');
    expect(searchRows(collected)[0].posts).toHaveLength(1);
    // 任务记住的是**新页**，下一轮直接复用它。
    expect(gone.tab()).toBe('research-tab');
    // 翻面：页还在时同样的输入只跑一次 —— 上面那次重试不是「每轮都跑两次」。
    status = 'available';
    const again = await runner({ search: searchInput.search }, gone.ctx);
    expect(again.browserTabId).toBe('research-tab');
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.open.mock.calls[1][1]).toBe('research-tab');
    expect(searchRows(again)[0].posts).toHaveLength(1);
  });

  it('retries a dead tab at most once', async () => {
    const f = fixture([searchHtml(post())]);
    const runner = createXResearchRunner(depsFor(f, { tabStatus: () => 'missing' }));
    // 重试开新页也失败（浏览器真的没法再开一页）：不许一轮接一轮地重放。
    f.open.mockImplementation(async () => { throw new KydogError('browser.no_tab', '标签页已关闭'); });
    const gone = harness();
    gone.bind('gone-tab');
    const result = await runner({ search: searchInput.search }, gone.ctx);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(searchRows(result).every((row) => row.stopReason === 'navigation_failed')).toBe(true);
    // 一行导航都没提交过，任务不再持有这张死页。
    expect(gone.tab()).toBeUndefined();
  });

  it('does not retry a batch where one row already committed a navigation', async () => {
    const f = fixture([searchHtml(post())]);
    const twoQueries = {
      search: {
        ...searchInput.search,
        queries: [query, { ...query, id: 'q3', query: 'second query' }],
      },
    };
    const runner = createXResearchRunner(depsFor(f));
    const submitted = harness();
    submitted.bind('live-tab');
    // 第一个 query 照常导航采集；第二个 query 撞上 no_tab。重放会把第一行已经观察到的帖重新采一遍。
    const defaultOpen = f.open.getMockImplementation()!;
    let opens = 0;
    f.open.mockImplementation(async (url: string, tabId?: string) => {
      opens += 1;
      if (opens === 2) throw new KydogError('browser.no_tab', '标签页已关闭');
      return defaultOpen(url, tabId);
    });
    const result = await runner(twoQueries, submitted.ctx);
    // 只跑了一轮：重试的话第一个 query 会被再开一次（3 次）。
    expect(opens).toBe(2);
    const rows = searchRows(result);
    // 已提交过导航的那一行保住它的结论，没提交的那一行老实说「导航失败」。
    expect(rows[0].location?.committedNavigationOutcome).toBeTruthy();
    expect(rows[0].status).not.toBe('failed');
    expect(rows[0].posts).toHaveLength(1);
    expect(rows[1].stopReason).toBe('navigation_failed');
  });

  it('needs no retry when the task has no tab at all', async () => {
    const f = fixture([readHtml(post())]);
    const runner = createXResearchRunner(depsFor(f));
    const fresh = harness();
    const read = await runner({ read: readWork }, fresh.ctx);
    // 没有标签页照旧以 `''` 传下去（`browser.open` 把空值当成「自己开一张」，R81e）：
    // 一轮就成，不存在「先失败再重试」。
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.open.mock.calls[0][1]).toBe('');
    expect(read.operation === 'read' && read.targets[0].status).toBe('observed');
    // 「任务记住这一轮开的页」在这里考不出来：替身把调用方给的 tabId 原样回给结果
    // （`'' ?? 'research-tab'` 仍是 `''`），只有 `undefined` 那次它才编一个 id。那一条在上面的
    // 重试用例里钉；而 `''` 真的开出一张页是 `browserService.open` 自己的契约（R81e）。
  });

  it('delivers a conclusion (collectionStop) for every row of every batch', async () => {
    const f = fixture([readHtml(post())]);
    // 三种批：绑定的页死了、重试开新页成功；绑定的页死了、重试也开不出来（两轮都失败）；
    // 页还活着（翻面对照）。三批的每一行都必须带着自己的结论 —— 序列化靠它分辨「采集收尾过」
    // 与「中途被砍」，所以这条判据不能只是「失败的那一批有」。
    const recover = harness();
    recover.bind('gone-tab');
    const recovered = await createXResearchRunner(depsFor(f, {
      tabStatus: (tabId) => (tabId === 'gone-tab' ? 'missing' : 'available'),
    }))({ search: searchInput.search }, recover.ctx);
    const unrecoverableSite = fixture([readHtml(post())]);
    unrecoverableSite.open.mockImplementation(async () => {
      throw new KydogError('browser.no_tab', '标签页已关闭');
    });
    const failing = harness();
    failing.bind('gone-tab');
    const failed = await createXResearchRunner(depsFor(unrecoverableSite, {
      tabStatus: () => 'missing',
    }))({ read: readWork }, failing.ctx);
    const alive = fixture([searchHtml(post()), readHtml(post())]);
    const live = createXResearchRunner(depsFor(alive));
    const collected = await live({ search: searchInput.search }, harness().ctx);
    const read = await live({ read: readWork }, harness().ctx);

    for (const result of [recovered, failed, collected, read]) {
      const rows = rowsOf(result);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.collectionStop).toEqual(conclusionOf(row));
    }
    // 前提：其中一批真的走进了「一行导航都没发生」那条路（上面的判据不是只对成功批次成立）。
    expect(rowsOf(failed).every((row) => row.stopReason === 'navigation_failed')).toBe(true);
    // 翻面：另一批照常采到帖子（两种形状都在这条用例里出现过）。
    expect(searchRows(collected)[0].posts).toHaveLength(1);
    expect(recovered.operation === 'search' && recovered.queries[0].status).not.toBe('failed');
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

  it('rejects request bounds before touching the browser', async () => {
    const f = fixture([searchHtml(post())]);
    const runner = createXResearchRunner(depsFor(f));
    // 边界内侧：4096 UTF-16 units，构造出的公开搜索 URL 仍在 8192 以内 —— 照旧跑。
    // 没有这一条，下面「一次浏览器都没碰」也可能只是「什么也没跑」。
    const boundary = 'a' + ' '.repeat(4095);
    const accepted = await runner({
      search: { ...searchInput.search, queries: [{ ...query, query: boundary }] },
    }, harness().ctx);
    expect(searchRows(accepted)[0].query.query).toBe(boundary);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(new URL(f.open.mock.calls[0][0]).searchParams.get('q')).toBe(boundary);
    const collected = f.collect.mock.calls.length;
    // 越过 query 上限：4100 units 与 4096 个汉字（URL 约 36 KB）都拒，且浏览器一次都没开。
    for (const text of ['a'.repeat(4100), '汉'.repeat(4096)]) {
      await expect(runner({
        search: { ...searchInput.search, queries: [{ ...query, query: text }] },
      }, harness().ctx)).rejects.toThrow('shorten or split');
      expect(f.open).toHaveBeenCalledTimes(1);
    }
    // read 的 target 同理：超长 URL 也必须在碰浏览器之前拒。
    await expect(runner({
      read: { ...readWork, targets: [{ url: 'https://x.com/alice/status/1' + 'x'.repeat(8192) }] },
    }, harness().ctx)).rejects.toThrow('shorter actually observed permalink');
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.collect).toHaveBeenCalledTimes(collected);
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
    const events: XResearchProgressEvent[] = [];
    const fresh = harness({ onProgress: (event) => events.push({ ...event }) });
    const read = await runner({ read: readWork }, fresh.ctx);
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(read.operation === 'read' && read.targets[0].root?.postId).toBe('123');
    // 读的一半也真的报了进度（spec §5.5）：先导航到 root，再落到收集段。没有这两句，
    // 采集侧少报一条或报错段落都不会红 —— 任务侧只会看到一条进度也没有。
    expect(events[0]).toMatchObject({
      section: 'read', rowIndex: 0, state: 'navigating', phaseDetail: 'root',
    });
    expect(events.some((event) => event.state === 'collecting')).toBe(true);
    expect(events.every((event) => event.section === 'read' && event.rowIndex === 0)).toBe(true);
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
      locate: async () => 'unused',
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
      // 这个用例只关心进度帧；交付的工件路径在 `xResearchDeliver.test.ts` 里钉。
      artifacts: () => tempXArtifactStore(),
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
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const result = await createXResearchRunner(depsFor(f))({ search: searchInput.search },
        harness({ onProgress: () => { throw new Error('observer failure'); } }).ctx);
      expect(searchRows(result)[0].posts).toHaveLength(1);
      expect(f.open).toHaveBeenCalledTimes(1);
      // 吞掉异常不等于静默：一个系统性坏掉的投影表现为「一条进度也没有」，日志是它唯一露面的地方。
      expect(warn).toHaveBeenCalledWith('x_research', 'progress observer threw',
        expect.objectContaining({ section: 'search', rowIndex: 0, state: 'navigating' }));
    } finally {
      warn.mockRestore();
    }
  });

  it('settles every search row as its collection ends, so the numerator reaches the total', async () => {
    const f = fixture([searchHtml(post())]);
    const root = mkdtempSync(path.join(os.tmpdir(), 'x-runner-settle-'));
    // 帧里的快照与内存里是同一批工作项对象，所以在收到的当下抄数字（与上一条同一个理由）。
    const settled: number[] = [];
    const service = new XResearchTaskService({
      store: new XResearchTaskStore(root),
      runWork: createXResearchRunner(depsFor(f)),
      onUpdate: (snapshot: XResearchTaskSnapshot) => settled.push(snapshot.counts.searchDone),
      artifacts: () => tempXArtifactStore(),
    });
    try {
      const submitted = await service.submit({
        work: {
          search: {
            ...searchInput.search,
            queries: [
              query, { ...query, id: 'q3', query: 'second query' },
              { ...query, id: 'q4', query: 'third query' },
            ],
          },
        },
      }, { threadId: '33333333-3333-4333-8333-333333333333', runId: RUN_ID, projectRoot: '/p' });
      await service.whenIdle('33333333-3333-4333-8333-333333333333', submitted.researchRunId);
      // 0 → 1 → 2 → 3，一行收尾长一格。R81g 的现场是三个 query 都跑完了、卡上还写「搜索 0/6」：
      // 分子只有收到那一行的终态进度才会动（停在 0 直到 `settle()` 的形态就是这次要修的东西）。
      expect(successiveValues(settled)).toEqual([0, 1, 2, 3]);
      const final = await service.get('33333333-3333-4333-8333-333333333333', submitted.researchRunId);
      expect(final.counts).toMatchObject({ searchDone: 3, searchTotal: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('settles every read row as its collection ends, so the numerator reaches the total', async () => {
    const f = fixture([readHtml(post())]);
    const root = mkdtempSync(path.join(os.tmpdir(), 'x-runner-settle-read-'));
    const settled: number[] = [];
    const service = new XResearchTaskService({
      store: new XResearchTaskStore(root),
      runWork: createXResearchRunner(depsFor(f)),
      onUpdate: (snapshot: XResearchTaskSnapshot) => settled.push(snapshot.counts.readDone),
      artifacts: () => tempXArtifactStore(),
    });
    try {
      const submitted = await service.submit({
        work: { read: { ...readWork, targets: [{ url: target }, { url: target }, { url: target }] } },
      }, { threadId: '44444444-4444-4444-8444-444444444444', runId: RUN_ID, projectRoot: '/p' });
      await service.whenIdle('44444444-4444-4444-8444-444444444444', submitted.researchRunId);
      expect(successiveValues(settled)).toEqual([0, 1, 2, 3]);
      const final = await service.get('44444444-4444-4444-8444-444444444444', submitted.researchRunId);
      expect(final.counts).toMatchObject({ readDone: 3, readTotal: 3 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('settles a row whose collection threw instead of leaving it running', async () => {
    // 收集里抛出的那一行（适配器坏了）与因此一行都没起跑的下一行，都必须报终态 —— 这就是把终态
    // 放在 `finally`、而不是「跑完那条路」上的理由：抛出 / 取消的行同样要收尾（R81g）。
    const f = fixture([searchHtml(post())], { collectErrorAt: 0 });
    const events: XResearchProgressEvent[] = [];
    const twoQueries = {
      search: { ...searchInput.search, queries: [query, { ...query, id: 'q3', query: 'second query' }] },
    };
    const result = await createXResearchRunner(depsFor(f))(
      twoQueries, harness({ onProgress: (event) => events.push({ ...event }) }).ctx);
    const stopped = events.filter((event) => event.state === 'stopped');
    expect(stopped.map((event) => event.rowIndex)).toEqual([0, 1]);
    expect(stopped.every((event) => event.phaseDetail === null)).toBe(true);
    // 终态事件带的是**结论**，不是采集层的初始值：卡片按它印「失败」。
    expect(searchRows(result).map((row) => row.status)).toEqual(['failed', 'failed']);
    expect(stopped.map((event) => event.row.status)).toEqual(['failed', 'failed']);
    // 翻面：抛出之前真的报过活着的阶段（上面两条不是「一条进度都没有」的空转）。
    expect(events.some((event) => event.state === 'collecting')).toBe(true);
    expect(events.some((event) => event.state === 'navigating')).toBe(true);
  });
});
