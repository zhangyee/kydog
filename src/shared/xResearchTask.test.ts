import { describe, it, expect } from 'vitest';
import {
  xResearchRoundsState, xResearchTaskSnapshot, xResearchTaskState,
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

  it('puts 运行 above 中断, and 中断 above 取消', () => {
    // 有活就说是「进行中」：`interrupted` 是黏的（一份失败的提交把它留在盘上，而 `submit` 允许往
    // 一段已中断的研究上追加工作），一段**正在采集**的研究不能因为那个词被判成中断 —— 卡会收起行
    // 列表、把取消入口藏掉，用户没有办法停下它。
    expect(xResearchTaskState([
      submission({ state: 'interrupted' }), submission({ state: 'running' }),
    ])).toBe('running');
    // 翻面：没有活的时候那个词才作数。
    expect(xResearchTaskState([
      submission({ state: 'interrupted' }),
      submission({ state: 'done', workItems: [item({ status: 'observed' })] }),
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

  it('carries who cancelled the research from the record onto the snapshot', () => {
    const cancelled = xResearchTaskSnapshot(
      record({ state: 'cancelled', stateReason: 'cancelled', cancelledBy: 'agent' }),
      [submission({ state: 'cancelled' })],
    );
    // 主语是盘上那条事实（R81a）：投影不猜「大概是谁」，也不因为状态是 cancelled 就默认为 user。
    expect(cancelled.cancelledBy).toBe('agent');
    // 翻面：同一个理由换一个主语 → 跟着换；没有字段（旧数据）→ 也说没有，不编一个。
    expect(xResearchTaskSnapshot(
      record({ state: 'cancelled', stateReason: 'cancelled', cancelledBy: 'user' }),
      [submission({ state: 'cancelled' })],
    ).cancelledBy).toBe('user');
    expect(xResearchTaskSnapshot(
      record({ state: 'cancelled', stateReason: 'cancelled' }),
      [submission({ state: 'cancelled' })],
    ).cancelledBy).toBeUndefined();
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
      // 六行里只有排队与在飞那两行还没收尾：分子是收尾数 4，不是成功数 1。
      searchDone: 4, searchTotal: 6, readDone: 0, readTotal: 0,
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
    // 每段的行数都不是「收尾数」（也不是「成功数」）：搜索 3 行只收尾 2 行（w-s3 还在滚），
    // 读取 4 行收尾 2 行（w-r3 在等、w-r4 排队）。若把 `search.length` / `read.length` 当成
    // 收尾数，这两对数字就相等，卡片会在运行中说「读取 4 个目标」—— 正是这条用例要挡下的那种假进度。
    expect([snap.counts.searchDone, snap.counts.searchTotal]).toEqual([2, 3]);
    expect([snap.counts.readDone, snap.counts.readTotal]).toEqual([2, 4]);
    expect(snap.counts.searchDone).not.toBe(snap.search.length);
    expect(snap.counts.readDone).not.toBe(snap.read.length);
    // 段内分子数的是「收尾」：搜索那行失败也算收尾（它在 failed 桶里，不在 done 桶里），
    // `done` 桶本身仍是只装成功的那一桶 —— 两个口径各自有断言钉着。
    expect(snap.counts.done).toBe(3);
    expect(snap.counts.failed).toBe(1);
  });

  it('counts settled rows in the numerator, so 2 successes + 2 failures reads 4/4', () => {
    const snap = xResearchTaskSnapshot(record(), [
      submission({ submissionId: 'sub-r', operation: 'read', state: 'done',
        endedAt: '2026-10-16T00:09:00.000Z', workItems: [
          item({ workItemId: 'w-r1', section: 'read', label: 'a', state: 'stopped', status: 'observed' }),
          item({ workItemId: 'w-r2', section: 'read', label: 'b', state: 'stopped', status: 'partial' }),
          item({ workItemId: 'w-r3', section: 'read', label: 'c', state: 'stopped',
            status: 'access_denied' }),
          item({ workItemId: 'w-r4', section: 'read', label: 'd', state: 'stopped',
            status: 'rate_limited' }),
        ] }),
    ]);
    // 四行全都收尾了：2 个成功 + 2 个失败。分子只数成功的话卡面会说「读取 2/4」，读者会以为
    // 还有两个目标在跑 —— 而那两行的结论早就在「失败 2」那一栏交代过了。
    expect([snap.counts.readDone, snap.counts.readTotal]).toEqual([4, 4]);
    // 对照：`done` 桶没有跟着分子改口径，仍是「只装成功」的那一桶（别的读者按它读）。
    expect(snap.counts.done).toBe(2);
    expect(snap.counts.failed).toBe(2);
  });

  it('keeps a partial numerator while a section still has queued and running rows', () => {
    const snap = xResearchTaskSnapshot(record(), [
      submission({ submissionId: 'sub-r', operation: 'read', state: 'running', workItems: [
        item({ workItemId: 'w-r1', section: 'read', label: 'a', state: 'stopped', status: 'observed' }),
        item({ workItemId: 'w-r2', section: 'read', label: 'b', state: 'stopped', status: 'failed' }),
        item({ workItemId: 'w-r3', section: 'read', label: 'c', state: 'collecting' }),
        item({ workItemId: 'w-r4', section: 'read', label: 'd', state: 'queued' }),
      ] }),
    ]);
    // 收尾 2 行（1 成功 + 1 失败）、另 2 行还没收尾：分子不能因为「失败也算收尾」就吞掉在飞的行。
    expect([snap.counts.readDone, snap.counts.readTotal]).toEqual([2, 4]);
    expect(snap.counts.running).toBe(1);
    expect(snap.counts.queued).toBe(1);
  });

  it('keeps a row whose on-disk section is neither segment out of the denominators', () => {
    const snap = xResearchTaskSnapshot(record(), [
      submission({ submissionId: 'sub-x', workItems: [
        item({ workItemId: 'w-s1', state: 'stopped', status: 'observed' }),
        // 盘上的 `section` 不是这两个词之一（store 直接 `JSON.parse(...) as`，坏值到不了类型层）。
        // 这行永远不会成为一行（快照两段都按这两个词过滤），所以也不该胀大任何一段的分母。
        item({ workItemId: 'w-bad', section: 'bogus' as XResearchWorkItem['section'], state: 'queued' }),
      ] }),
    ]);
    expect([snap.counts.searchDone, snap.counts.searchTotal]).toEqual([1, 1]);
    // 坏值曾被 `else` 收进读取那一支：卡上会写「读取 1/1」，而读取段一行都没有。
    expect([snap.counts.readDone, snap.counts.readTotal]).toEqual([0, 0]);
    // 对照：它确实不是一行（分母之外的原因也交代清楚：两段列表各自按词过滤）。
    expect(snap.search).toHaveLength(1);
    expect(snap.read).toEqual([]);
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

  it('keeps each row\'s submissionId so the card can regroup one research into rounds', () => {
    // 现场形状（一张卡里一次研究跑了四次提交）：搜 5、补搜 3、读 3、补读 2。分组只能按
    // `submissionId` —— 提交的 `createdAt` 与行序都不在这个字段里，而卡也不该从时间窗去猜。
    // **行上不写这个字段**：那正是旧提交文件的形状，而「这行是哪一份提交计划出来的」由投影从
    // 拥有它的那份提交盖上（对照在下面：行上本来就写着同一个 id 时结果逐字相同）。
    const round = (submissionId: string, operation: 'search' | 'read', labels: string[]) =>
      submission({ submissionId, operation, state: 'done', workItems: labels.map((label, at) =>
        item({ workItemId: `${submissionId}-${at}`,
          section: operation, label, state: 'stopped', status: 'observed' })) });
    const four = [
      round('sub-1', 'search', ['s1', 's2', 's3', 's4', 's5']),
      round('sub-2', 'search', ['s6', 's7', 's8']),
      round('sub-3', 'read', ['r1', 'r2', 'r3']),
      round('sub-4', 'read', ['r4', 'r5']),
    ];
    const snap = xResearchTaskSnapshot(record(), four);
    // 字段真的落到了投影上，而行序就是提交序 → 提交内行序（不重排）。
    expect(snap.search.map((row) => row.submissionId)).toEqual([
      'sub-1', 'sub-1', 'sub-1', 'sub-1', 'sub-1', 'sub-2', 'sub-2', 'sub-2']);
    expect(snap.read.map((row) => row.submissionId)).toEqual([
      'sub-3', 'sub-3', 'sub-3', 'sub-4', 'sub-4']);
    // 按提交分组，就是「四轮、5/3/3/2」那个形状。
    const regroup = (rows: readonly XResearchWorkItem[]) => rows.reduce<Array<[string, number]>>(
      (acc, row) => {
        const last = acc[acc.length - 1];
        if (last && last[0] === row.submissionId) last[1] += 1;
        else acc.push([row.submissionId!, 1]);
        return acc;
      }, []);
    expect(regroup(snap.search)).toEqual([['sub-1', 5], ['sub-2', 3]]);
    expect(regroup(snap.read)).toEqual([['sub-3', 3], ['sub-4', 2]]);

    // 对照：同一批提交的行**本来就盖着**同一个 id（新数据）时，分段形状逐字相同 ——
    // 上面那两行不是因为行上原本写着，而是投影盖上去的。
    const stamped = xResearchTaskSnapshot(record(), four.map((one) => submission({
      ...one, workItems: one.workItems.map((row) => ({ ...row, submissionId: one.submissionId })),
    })));
    expect(stamped.search.map((row) => row.submissionId)).toEqual(snap.search.map((row) => row.submissionId));
    expect(stamped.read.map((row) => row.submissionId)).toEqual(snap.read.map((row) => row.submissionId));
    expect(stamped.counts).toEqual(snap.counts);
  });

  it('lists every submission as one round, in submit order, with its own operation and objective', () => {
    const at = (minute: number) => `2026-10-16T00:0${minute}:00.000Z`;
    // 现场形状（R83）：一个目标下几轮，其中一轮被模型取消；同一个目标可以横跨两段研究。
    const snap = xResearchTaskSnapshot(
      record({ state: 'completed', stateReason: 'cancelled', cancelledBy: 'agent' }),
      // 输入数组刻意不按时间排（第三份提交夹在中间）：`rounds` 的次序只能来自提交自己的
      // `createdAt`，不能来自「这次调用恰好先读到哪个文件」。第一份仍是最早的那一份 ——
      // 卡头副标题取它（R10），而那是输入次序，不是这里排出来的次序。
      [
        submission({ submissionId: 'sub-1', objective: 'macOS 轻量虚拟化', state: 'cancelled',
          createdAt: at(1), endedAt: at(2) }),
        submission({ submissionId: 'sub-3', objective: '补读引信', state: 'done',
          createdAt: at(4), endedAt: at(5) }),
        submission({ submissionId: 'sub-2', operation: 'read', objective: '补读引信', state: 'done',
          createdAt: at(2), endedAt: at(3) }),
      ],
    );
    // 提交序由 `createdAt` 说（输入数组的次序不参与）：卡按这个次序画轮次头。
    expect(snap.rounds!.map((round) => [round.submissionId, round.operation, round.objective]))
      .toEqual([
        ['sub-1', 'search', 'macOS 轻量虚拟化'],
        ['sub-2', 'read', '补读引信'],
        ['sub-3', 'search', '补读引信'],
      ]);
    // 被取消的那一轮带着「为什么停」与「谁停的」：R81a 的归因按轮给，卡上不必再猜主语。
    expect(snap.rounds![0]).toMatchObject({ state: 'cancelled', stateReason: 'cancelled', cancelledBy: 'agent' });
    // 对照：没被取消的轮次不带这两项 —— 上面那一行不是因为每一轮都盖着。
    expect(snap.rounds![1].cancelledBy).toBeUndefined();
    expect(snap.rounds![1].stateReason).toBeUndefined();
    // 同一毫秒的两份提交按 id 定序：只比 `createdAt` 时它们的先后取决于提交文件的枚举序，
    // 而卡片不能用一个「同一个盘读两次给出不同次序」的东西当分段依据。
    const sameMoment = xResearchTaskSnapshot(record(), [
      submission({ submissionId: 'sub-b', createdAt: at(6) }),
      submission({ submissionId: 'sub-a', createdAt: at(6) }),
    ]);
    expect(sameMoment.rounds!.map((round) => round.submissionId)).toEqual(['sub-a', 'sub-b']);
    // 其余事实照旧：投影只多了一列 `rounds`。
    expect(snap.counts.submissions).toBe(3);
    expect(snap.objective).toBe('macOS 轻量虚拟化');
  });
});

describe('xResearchRoundsState：一组提交的终态（研究 / 卡上的一个目标共用一把尺子）', () => {
  const row = (status: XResearchWorkItem['status']) => item({ state: 'stopped', status });

  it('only says 取消 when every round of the group was cancelled', () => {
    // 一个目标被取消后又补了一轮跑完：这一段是**完成**的，被取消的是其中一轮（轮次头上另有记号）。
    expect(xResearchRoundsState(['cancelled', 'done'], [row('cancelled'), row('observed')])).toBe('completed');
    // 对照：整组都是取消 → 取消（研究级的「全部取消才算取消」原样适用于组）。
    expect(xResearchRoundsState(['cancelled'], [row('cancelled')])).toBe('cancelled');
    // 有活就说是进行中，其次中断；失败只在没有这些时才算。
    expect(xResearchRoundsState(['cancelled', 'queued'], [])).toBe('running');
    expect(xResearchRoundsState(['cancelled', 'interrupted'], [])).toBe('interrupted');
    expect(xResearchRoundsState(['done'], [row('access_denied')])).toBe('failed');
  });
});
