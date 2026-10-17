import { describe, it, expect } from 'vitest';
import {
  xResearchTaskSnapshot, xResearchTaskState,
  type XResearchSubmission, type XResearchTaskRecord, type XResearchWorkItem,
} from './xResearchTask';

const item = (over: Partial<XResearchWorkItem> = {}): XResearchWorkItem => ({
  workItemId: 'w-1', section: 'search', label: 'Qwen3.8 27B', product: 'Top',
  state: 'queued', phaseDetail: null, status: null, stopReason: null, reason: null,
  posts: 0, omitted: 0, pages: 0, hasRoot: false, replies: 0,
  article: 'not_requested', scrolls: 0, expandActions: 0, ...over,
});

const submission = (over: Partial<XResearchSubmission> = {}): XResearchSubmission => ({
  version: 1, submissionId: 'sub-1', researchRunId: 'run-1', threadId: 'thread-1',
  submitCallId: 'call-submit-1', batchId: 'xbatch_1', runId: 'run-1',
  operation: 'search', objective: '第一段目标', state: 'running',
  budget: { scrolls: 0, expandActions: 0 }, usage: { posts: 0, scrolls: 0, expandActions: 0 },
  workItems: [], createdAt: '2026-10-16T00:00:00.000Z', endedAt: null, ...over,
});

const record = (over: Partial<XResearchTaskRecord> = {}): XResearchTaskRecord => ({
  version: 1, researchRunId: 'run-1', threadId: 'thread-1', projectRoot: '/tmp/project',
  createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:05:00.000Z',
  revision: 7, state: 'running', browserTabId: 'tab-1',
  submissionIds: ['sub-search', 'sub-read'], ...over,
});

// 两段提交的数字刻意都不等于合计：搜索 87 帖 / 滚动 10 / 展开 1，读取 0 帖 / 滚动 2 / 展开 1，
// 于是「合计 87 / 12 / 2」只能来自两段相加，抄单段或取最大值都对不上。
const searchSub = () => submission({
  submissionId: 'sub-search', objective: 'Qwen3.8 27B 量化版在 agentic 任务上的实际表现',
  state: 'done', budget: { scrolls: 12500, expandActions: 9000 },
  workItems: [item({ workItemId: 'w-s1', label: 'Qwen3.8 27B', state: 'stopped', status: 'partial',
    stopReason: 'budget_reached', posts: 87, omitted: 12, pages: 3, scrolls: 10, expandActions: 1 })],
  createdAt: '2026-10-16T00:00:00.000Z', endedAt: '2026-10-16T00:04:00.000Z',
  deliveredAt: '2026-10-16T00:04:10.000Z', deliveryCallId: 'call-deliver-1',
});

const readSub = () => submission({
  submissionId: 'sub-read', operation: 'read', objective: '第二段：读三个帖子的正文与回复',
  state: 'done', budget: { scrolls: 0, expandActions: 1000 },
  workItems: [item({ workItemId: 'w-r1', section: 'read', label: 'x.com/a/status/1', product: null,
    state: 'stopped', status: 'observed', hasRoot: true, replies: 7, article: 'body', scrolls: 2,
    expandActions: 1 })],
  createdAt: '2026-10-16T00:04:00.000Z', endedAt: '2026-10-16T00:09:00.000Z',
});

describe('xResearchTaskState：状态只从提交与工作项推出来', () => {
  it('derives 完成 only when every work item finished in a success status', () => {
    expect(xResearchTaskState([submission({ state: 'done', workItems: [item({ status: 'observed' })] })]))
      .toBe('completed');
    expect(xResearchTaskState([submission({ state: 'done', workItems: [item({ status: 'failed' })] })]))
      .toBe('failed');
    expect(xResearchTaskState([submission({ state: 'running', workItems: [item({ status: null })] })]))
      .toBe('running');
    expect(xResearchTaskState([submission({ state: 'cancelled', workItems: [item({ status: 'cancelled' })] })]))
      .toBe('cancelled');
    expect(xResearchTaskState([submission({ state: 'interrupted', workItems: [item({ status: null })] })]))
      .toBe('interrupted');
  });

  it('puts 中断 above 取消 and 运行 above 失败', () => {
    expect(xResearchTaskState([
      submission({ state: 'interrupted' }), submission({ state: 'running' }),
    ])).toBe('interrupted');
    expect(xResearchTaskState([
      submission({ state: 'running', workItems: [item({ status: 'failed' })] }),
    ])).toBe('running');
    // 「全部取消」才算取消：另一段已完成（且成功）时落回完成。
    expect(xResearchTaskState([
      submission({ state: 'cancelled', workItems: [item({ state: 'stopped', status: 'cancelled' })] }),
      submission({ state: 'done', workItems: [item({ state: 'stopped', status: 'observed' })] }),
    ])).toBe('completed');
  });

  it('answers 完成 for the empty list — a value the caller must never hand in', () => {
    // 没有提交就没有结论；这个 completed 是「没东西可判」的意外值，不是判定结果（见函数注释）。
    expect(xResearchTaskState([])).toBe('completed');
  });

  it('scans every work item for a failure, not just one of them', () => {
    expect(xResearchTaskState([submission({ state: 'done', workItems: [
      item({ status: 'observed' }), item({ status: 'failed' }),
    ] })])).toBe('failed');
    // 同一条提交里两个都成功时仍是完成：上一条答 failed 不是因为「有工作项」。
    expect(xResearchTaskState([submission({ state: 'done', workItems: [
      item({ status: 'observed' }), item({ status: 'observed' }),
    ] })])).toBe('completed');
  });

  it('treats partial / explicit_empty as success and the six source refusals as failure', () => {
    for (const status of ['observed', 'partial', 'explicit_empty'] as const) {
      expect(xResearchTaskState([submission({ state: 'done', workItems: [item({ status })] })]))
        .toBe('completed');
    }
    for (const status of ['failed', 'unavailable', 'access_denied', 'auth_required',
      'rate_limited', 'action_required'] as const) {
      expect(xResearchTaskState([submission({ state: 'done', workItems: [item({ status })] })]))
        .toBe('failed');
    }
  });
});

describe('xResearchTaskSnapshot：研究级快照全是事实的投影', () => {
  it('splits work items into search and read sections and sums usage', () => {
    const snap = xResearchTaskSnapshot(record(), [searchSub(), readSub()]);
    expect(snap.search.map((i) => i.label)).toEqual(['Qwen3.8 27B']);
    expect(snap.read.map((i) => i.label)).toEqual(['x.com/a/status/1']);
    expect(snap.usage).toEqual({ posts: 87, scrolls: 12, expandActions: 2 });
    expect(snap.counts.undelivered).toBe(1);
  });

  it('keeps each section in submission order and within-submission order', () => {
    const snap = xResearchTaskSnapshot(record(), [
      searchSub(),
      readSub(),
      submission({ submissionId: 'sub-search-2', state: 'done',
        endedAt: '2026-10-16T00:12:00.000Z', workItems: [
          item({ workItemId: 'w-s2', label: 'Qwen3.8 27B 反量化', state: 'stopped', status: 'observed' }),
          item({ workItemId: 'w-s3', label: 'Qwen3.8 27B GGUF', state: 'stopped', status: 'observed' }),
        ] }),
    ]);
    // 第二个 search 提交排在唯一一个 read 提交之后，仍必须落在头两个 search 行之后；
    // 同一条提交内的两行也保持声明顺序（卡片编号由数组顺序生成，投影不排序、不去重）。
    expect(snap.search.map((i) => i.label)).toEqual([
      'Qwen3.8 27B', 'Qwen3.8 27B 反量化', 'Qwen3.8 27B GGUF',
    ]);
    expect(snap.read.map((i) => i.label)).toEqual(['x.com/a/status/1']);
  });

  it('counts 帖 only from search rows, so a read row cannot double-count the header', () => {
    const snap = xResearchTaskSnapshot(record(), [
      searchSub(),
      submission({ submissionId: 'sub-read-2', operation: 'read', state: 'done',
        endedAt: '2026-10-16T00:12:00.000Z', workItems: [item({
          section: 'read', label: 'x.com/a/status/2', state: 'stopped', status: 'observed', posts: 5,
        })] }),
    ]);
    // 搜索行的 87 照旧累加（对照）；读取行那 5 帖不进卡头：§5.4 的「收 N 帖」就是搜索行的去重帖数。
    expect(snap.counts.posts).toBe(87);
    expect(snap.usage.posts).toBe(87);
  });

  it('reads a delivered flag that the store parsed as null as still undelivered', () => {
    const snap = xResearchTaskSnapshot(record(), [
      // 对照：真时间戳才算交付过。
      submission({ submissionId: 'sub-delivered', state: 'done',
        endedAt: '2026-10-16T00:02:00.000Z',
        deliveredAt: '2026-10-16T00:02:10.000Z', deliveryCallId: 'call-deliver-1' }),
      // store 把 submission-*.json 直接 `JSON.parse ... as XResearchSubmission`，不校验：
      // 写成 `deliveredAt: null` 的没交付，不能因为「不等于 undefined」就被当成交付过。
      submission({ submissionId: 'sub-null-delivered', state: 'done',
        endedAt: '2026-10-16T00:03:00.000Z', deliveredAt: null as unknown as string }),
    ]);
    expect(snap.counts.undelivered).toBe(1);
  });

  it('treats a submission with no endedAt as still running, not as ended and undelivered', () => {
    const snap = xResearchTaskSnapshot(record(), [
      // 对照：收尾了、也没有交付标记 → 算没交付。
      submission({ submissionId: 'sub-ended', state: 'done', endedAt: '2026-10-16T00:02:00.000Z' }),
      // 缺 `endedAt` 的是还没收尾，不是「已收尾且没交付」—— 算进去就是给未来记账。
      submission({ submissionId: 'sub-missing-ended', state: 'running',
        endedAt: undefined as unknown as null }),
    ]);
    expect(snap.counts.undelivered).toBe(1);
  });

  it('copies lifecycle fields from the record and totals the submitted budgets', () => {
    const snap = xResearchTaskSnapshot(
      record({ state: 'interrupted', stateReason: '中断于 running', revision: 9 }),
      [searchSub(), readSub()],
    );
    // 盘上的生命周期是记录说了算（恢复时由 service 写 interrupted），不是把提交再推一遍：
    // 两段都是 done，推导会给出 completed。
    expect(snap.state).toBe('interrupted');
    expect(snap.stateReason).toBe('中断于 running');
    expect(snap.revision).toBe(9);
    expect(snap.researchRunId).toBe('run-1');
    expect(snap.threadId).toBe('thread-1');
    expect(snap.browserTabId).toBe('tab-1');
    expect(snap.createdAt).toBe('2026-10-16T00:00:00.000Z');
    expect(snap.updatedAt).toBe('2026-10-16T00:05:00.000Z');
    // 卡头显示的是这段研究最初要回答的问题，不是最后一次追加的目标。
    expect(snap.objective).toBe('Qwen3.8 27B 量化版在 agentic 任务上的实际表现');
    expect(snap.budget).toEqual({ scrolls: 12500, expandActions: 10000 });
    expect(snap.counts.submissions).toBe(2);
  });

  it('puts every work item in exactly one bucket by its state and status', () => {
    const snap = xResearchTaskSnapshot(record(), [submission({ workItems: [
      item({ state: 'queued' }),
      item({ state: 'collecting' }),
      item({ state: 'stopped', status: 'observed' }),
      item({ state: 'stopped', status: 'rate_limited' }),
      item({ state: 'stopped', status: 'cancelled' }),
      item({ state: 'stopped', status: null }),
    ] })]);
    expect(snap.counts).toEqual({
      submissions: 1, queued: 1, running: 1, done: 1, failed: 1, cancelled: 1, interrupted: 1,
      posts: 0, replies: 0, articles: 0, undelivered: 0,
      searchDone: 1, searchTotal: 6, readDone: 0, readTotal: 0,
    });
  });

  it('tracks per-section progress separately from the section row count', () => {
    const snap = xResearchTaskSnapshot(record(), [
      submission({ submissionId: 'sub-s', state: 'running', workItems: [
        item({ workItemId: 'w-s1', state: 'stopped', status: 'observed' }),
        item({ workItemId: 'w-s2', state: 'stopped', status: 'failed' }),
        item({ workItemId: 'w-s3', state: 'scrolling' }),
      ] }),
      submission({ submissionId: 'sub-r', operation: 'read', state: 'running',
        workItems: [
          item({ workItemId: 'w-r1', section: 'read', label: 'a', state: 'stopped', status: 'observed' }),
          item({ workItemId: 'w-r2', section: 'read', label: 'b', state: 'stopped', status: 'partial' }),
          item({ workItemId: 'w-r3', section: 'read', label: 'c', state: 'waiting' }),
          item({ workItemId: 'w-r4', section: 'read', label: 'd', state: 'queued' }),
        ] }),
    ]);
    // 每段的行数都不是「已完成数」：搜索 3 行只完成 1 行，读取 4 行完成 2 行。
    // 若把 `search.length` / `read.length` 当成完成数，这两对数字就相等，卡片会在运行中说
    // 「读取 4 个目标」—— 正是这条用例要挡下的那种假进度。
    expect([snap.counts.searchDone, snap.counts.searchTotal]).toEqual([1, 3]);
    expect([snap.counts.readDone, snap.counts.readTotal]).toEqual([2, 4]);
    expect(snap.counts.searchDone).not.toBe(snap.search.length);
    expect(snap.counts.readDone).not.toBe(snap.read.length);
    // 失败的那一行没有落进 `done` 桶：段内计数与 `done` 桶是同一把尺子（另有 failed 桶）。
    expect(snap.counts.done).toBe(3);
    expect(snap.counts.failed).toBe(1);
  });

  it('counts an article only when its body was read, and a delivery only when the submission ended', () => {
    const snap = xResearchTaskSnapshot(record(), [
      submission({ submissionId: 'sub-a', state: 'done', endedAt: '2026-10-16T00:02:00.000Z',
        workItems: [item({ section: 'read', label: 'a', article: 'body', replies: 3 })] }),
      submission({ submissionId: 'sub-b', state: 'done', endedAt: '2026-10-16T00:03:00.000Z',
        deliveredAt: '2026-10-16T00:03:10.000Z', deliveryCallId: 'call-deliver-b',
        workItems: [item({ section: 'read', label: 'b', article: 'entry', replies: 2 })] }),
      // 还没收尾的提交算「没交付」也不对：它压根还没有结果。
      submission({ submissionId: 'sub-c', state: 'running', endedAt: null }),
    ]);
    expect(snap.counts.articles).toBe(1);
    expect(snap.counts.replies).toBe(5);
    expect(snap.counts.undelivered).toBe(1);
  });
});
