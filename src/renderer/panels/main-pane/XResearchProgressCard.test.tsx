import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findAllWhere, mount } from '../../../test-support/miniReact';
import {
  xResearchTaskSnapshot,
  type XResearchSubmission, type XResearchTaskRecord, type XResearchTaskSnapshot,
  type XResearchWorkItem,
} from '../../../shared/xResearchTask';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});
// 这个替身按自己的 selector 同步读真 store：miniReact 没有调度器，订阅那一层在这里没有意义。
vi.mock('../../stores/xResearchTaskStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/xResearchTaskStore')>();
  const real = mod.useXResearchTaskStore;
  const hook = ((selector: (state: ReturnType<typeof real.getState>) => unknown) =>
    selector(real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useXResearchTaskStore: hook };
});

const { XResearchProgressCard } = await import('./XResearchProgressCard');
const { useXResearchTaskStore } = await import('../../stores/xResearchTaskStore');
const { useConfirmStore } = await import('../../stores/confirmStore');

const props = { threadId: 'thread-1', researchRunId: 'xrun-a' };
const FAILED_REASON = '该帖所在的对话要求登录才能看';
const invoke = vi.fn<(method: string, args?: unknown) => Promise<unknown>>();

function workItem(over: Pick<XResearchWorkItem, 'section' | 'label'> & Partial<XResearchWorkItem>):
XResearchWorkItem {
  return {
    workItemId: `${over.section}-${over.label}`, product: null, state: 'queued', phaseDetail: null,
    status: null, stopReason: null, reason: null, posts: 0, omitted: 0, pages: 0, hasRoot: false,
    replies: 0, article: 'not_requested', scrolls: 0, expandActions: 0, ...over,
  };
}

// 一条搜索行收尾成「收完」，一条卡在预算上（另省 12）；读取行两收尾（读完 / 被登录墙挡住）、
// 一条还在等（实时动作数只有这一行有）。
const SEARCH_ROWS: XResearchWorkItem[] = [
  workItem({ section: 'search', label: 'Qwen3.8 27B', product: 'Top', state: 'stopped',
    status: 'observed', posts: 87, pages: 3 }),
  workItem({ section: 'search', label: 'Qwen3.8 Q4 量化', product: 'Latest', state: 'stopped',
    status: 'partial', stopReason: 'budget_reached', posts: 41, omitted: 12, pages: 2 }),
];
const READ_ROWS: XResearchWorkItem[] = [
  workItem({ section: 'read', label: 'https://x.com/acme/status/19581', state: 'stopped',
    status: 'observed', hasRoot: true, replies: 42, article: 'body' }),
  workItem({ section: 'read', label: 'https://x.com/acme/status/19583', state: 'stopped',
    status: 'access_denied', reason: FAILED_REASON, article: 'failed' }),
  workItem({ section: 'read', label: 'https://x.com/acme/status/19590', state: 'waiting',
    phaseDetail: 'discussion', hasRoot: true, article: 'pending', expandActions: 18, scrolls: 6 }),
  // 还没起跑的那一行：文章状态是提交时就声明过的义务（没要文章），不是结论。
  workItem({ section: 'read', label: 'https://x.com/acme/status/19595', state: 'queued' }),
];

function snapshot(over: Partial<XResearchTaskSnapshot> = {}): XResearchTaskSnapshot {
  const base: XResearchTaskSnapshot = {
    researchRunId: 'xrun-a', threadId: 'thread-1', revision: 1, state: 'running',
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:01.000Z',
    objective: 'Qwen3.8 27B 量化版在 agentic 任务上的实际表现',
    counts: { submissions: 2, queued: 1, running: 1, done: 3, failed: 1, cancelled: 0,
      interrupted: 0, posts: 128, replies: 42, articles: 1, undelivered: 0,
      // 搜索两行都收尾了；读取四行只有一行落进 done 桶（19590 在飞、19595 排队）。
      searchDone: 2, searchTotal: 2, readDone: 1, readTotal: 4 },
    budget: { scrolls: 12500, expandActions: 10000 },
    usage: { posts: 128, scrolls: 12, expandActions: 2 },
    search: SEARCH_ROWS, read: READ_ROWS,
  };
  // 终态快照里没有排队/在飞的行（生产里 `settle` / `cancelSubmission` 把它们都收尾了）：
  // 夹具跟着这条不变量走，否则一个「完成」的快照还带着 queued/running 的计数 —— 那是造不出来的形状。
  // 想造「状态词与计数各说各的」那条用例自己给 `counts`（取消入口的判据靠它翻面）。
  if (over.state !== undefined && over.state !== 'running' && over.counts === undefined) {
    return { ...base, ...over, counts: { ...base.counts, queued: 0, running: 0 } };
  }
  return { ...base, ...over };
}
const running = snapshot();

function visibleText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join('');
  return visibleText((node as { props?: { children?: unknown } }).props?.children);
}

function rows(tree: unknown) {
  return findAllWhere(tree, (element) => element.props['data-testid'] === 'x-research-row');
}

function phaseDetails(tree: unknown) {
  return findAllWhere(tree, (element) => element.props['data-testid'] === 'x-research-phase-detail');
}

/** 发了几次 `taskGet`：补取（服务接上 / 行从池里消失）的判据就是多出来的一次请求。 */
function taskGetCalls(): number {
  return invoke.mock.calls.filter(([method]) => method === 'xResearch.taskGet').length;
}

describe('XResearchProgressCard', () => {
  beforeEach(() => {
    useXResearchTaskStore.setState({ snapshotsByRunId: {} });
    useConfirmStore.setState({ request: null });
    invoke.mockReset();
    invoke.mockResolvedValue(running);
    (globalThis as unknown as { window: unknown }).window = { kydog: { invoke } };
  });

  it('expands by default while running and collapses on the terminal state', async () => {
    useXResearchTaskStore.getState().upsert(running);
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();

    expect(mounted.find('x-research-card').props['data-status']).toBe('running');
    expect(rows(mounted.tree)).toHaveLength(6);

    useXResearchTaskStore.getState().upsert(snapshot({ revision: 2, state: 'completed' }));
    mounted.rerender(props);

    expect(mounted.find('x-research-card').props['data-status']).toBe('completed');
    expect(rows(mounted.tree)).toHaveLength(0);
    // 收起只收掉两段列表：摘要与预算行仍在，否则终态卡上什么数字都没有。
    expect(visibleText(mounted.find('x-research-summary'))).toContain('收 128 帖');
    // 读取段的分母是目标总数、分子是快照的按段完成数：运行中说「读取 4 个目标」是假进度。
    expect(visibleText(mounted.find('x-research-summary')))
      .toContain('搜索 2/2 个 query');
    expect(visibleText(mounted.find('x-research-summary')))
      .toContain('读取 1/4 个目标');
    expect(visibleText(mounted.find('x-research-budget'))).toBe('滚动 12/12500 · 展开 2/10000');
  });

  it('groups rows into 搜索 / 读取 sections with per-section numbering', async () => {
    useXResearchTaskStore.getState().upsert(running);
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();

    const searchText = visibleText(mounted.find('x-research-search'));
    const readText = visibleText(mounted.find('x-research-read'));
    expect(searchText.startsWith('搜索')).toBe(true);
    expect(readText.startsWith('读取')).toBe(true);

    // 每一段各自从 ① 起：用行序而非「出现过 ①」来断，否则两段共用一个计数器也绿。
    const order = (text: string, parts: string[]) => parts.map((part) => {
      const at = text.indexOf(part);
      expect(at, `${part} 不在这一段的文本里：${text}`).toBeGreaterThanOrEqual(0);
      return at;
    });
    const search = order(searchText, ['①', 'Qwen3.8 27B', '②', 'Qwen3.8 Q4 量化']);
    expect(search).toEqual([...search].sort((a, b) => a - b));
    const read = order(readText, ['①', 'status/19581', '②', 'status/19583']);
    expect(read).toEqual([...read].sort((a, b) => a - b));
    // 读取段的 ① 与搜索段的 ① 是同一个字符：这条断的是「两段都从头数」，不是「只有一个 ①」。
    expect(searchText.indexOf('搜索①')).toBe(0);
    expect(readText.indexOf('读取①')).toBe(0);
  });

  it('reads a section that finished with failures as settled, not as still running', async () => {
    const record: XResearchTaskRecord = {
      version: 1, researchRunId: 'xrun-a', threadId: 'thread-1', projectRoot: '/tmp/project',
      createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:05.000Z',
      revision: 1, state: 'failed', submissionIds: ['sub-read'],
    };
    const readSubmission: XResearchSubmission = {
      version: 1, submissionId: 'sub-read', researchRunId: 'xrun-a', threadId: 'thread-1',
      submitCallId: 'call-submit-1', batchId: 'xbatch_1', runId: 'xrun-a',
      operation: 'read', objective: '读四个目标', state: 'done',
      budget: { scrolls: 0, expandActions: 0 }, usage: { posts: 0, scrolls: 0, expandActions: 0 },
      workItems: [
        workItem({ section: 'read', label: 'status/1', state: 'stopped', status: 'observed' }),
        workItem({ section: 'read', label: 'status/2', state: 'stopped', status: 'explicit_empty' }),
        workItem({ section: 'read', label: 'status/3', state: 'stopped', status: 'access_denied',
          reason: FAILED_REASON }),
        workItem({ section: 'read', label: 'status/4', state: 'stopped', status: 'failed' }),
      ],
      createdAt: '2026-10-16T00:00:00.000Z', endedAt: '2026-10-16T00:00:05.000Z',
    };
    // 快照走真投影：卡面上那个分子只能从 `xResearchTaskSnapshot` 来，不是手写的字面量。
    const projected = xResearchTaskSnapshot(record, [readSubmission]);
    invoke.mockResolvedValue(projected);
    useXResearchTaskStore.getState().upsert(projected);
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();

    const summary = visibleText(mounted.find('x-research-summary'));
    // 2 成功 + 2 失败、四个目标全都收尾了：卡面必须说「读取 4/4」，说「读取 2/4」就是谎报还有两个在跑。
    expect(summary).toContain('读取 4/4 个目标');
    // 失败那两行没有被藏起来：结论在同一个摘要行里（这一条同时把「分子不是成功数」钉住）。
    expect(summary).toContain('失败 2');
  });

  it('shows the exact failure text of a failed target next to a successful one', async () => {
    useXResearchTaskStore.getState().upsert(running);
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();

    const rowTexts = rows(mounted.tree).map(visibleText);
    const failed = rowTexts.find((text) => text.includes('status/19583'));
    const observed = rowTexts.find((text) => text.includes('status/19581'));
    expect(failed).toContain(FAILED_REASON);
    expect(failed).toContain('访问被拒');
    expect(observed).toContain('已读');
    // 反面对照在同一条用例里：成功那行确实渲染了结论文本（不是空行），且不带这条失败原因。
    expect(observed).toContain('根帖 + 42 回复');
    expect(observed).not.toContain(FAILED_REASON);
  });

  it('keeps a user-collapsed card collapsed across state changes', async () => {
    useXResearchTaskStore.getState().upsert(running);
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();

    expect(rows(mounted.tree)).toHaveLength(6);
    expect(mounted.query('x-research-cancel')).not.toBeNull();
    mounted.find('x-research-toggle').props.onClick();
    expect(rows(mounted.tree)).toHaveLength(0);

    useXResearchTaskStore.getState().upsert(snapshot({ revision: 2, state: 'completed' }));
    mounted.rerender(props);
    expect(rows(mounted.tree)).toHaveLength(0);
    // 终态不给取消入口（同一条用例里上面已经证明运行中有）。
    expect(mounted.query('x-research-cancel')).toBeNull();

    // 终态再回到运行是真实路径（重启修复后往收尾的研究上再提交一段）。手动收起仍然说话算数：
    // 如果 `manualExpanded` 在每次状态变化时被重置，这一条会重新展开。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 3, state: 'running' }));
    mounted.rerender(props);
    expect(rows(mounted.tree)).toHaveLength(0);

    // 手动点过之后这一层就以点击为准：再点一次仍然展开得回来。
    mounted.find('x-research-toggle').props.onClick();
    expect(rows(mounted.tree)).toHaveLength(6);

    // 没点过的对照：同一张卡从终态回到运行时按默认规则重新展开（上一条不是「永远收起」）。
    invoke.mockResolvedValue(snapshot({ revision: 4, state: 'completed' }));
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 4, state: 'completed' }));
    const untouched = mount(XResearchProgressCard, props);
    await untouched.settle();
    expect(rows(untouched.tree)).toHaveLength(0);
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 5, state: 'running' }));
    untouched.rerender(props);
    expect(rows(untouched.tree)).toHaveLength(6);
  });

  it('reads every row number from that row and only reports live actions while it runs', async () => {
    useXResearchTaskStore.getState().upsert(running);
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();
    const rowTexts = rows(mounted.tree).map(visibleText);
    const byLabel = (label: string) => rowTexts.find((text) => text.includes(label))!;

    const collected = byLabel('Qwen3.8 27B');
    expect(collected).toContain('Top');
    expect(collected).toContain('收完');
    expect(collected).toContain('收 87 帖');
    expect(collected).toContain('3 页');
    expect(collected).not.toContain('另省');

    const budgeted = byLabel('Qwen3.8 Q4 量化');
    expect(budgeted).toContain('Latest');
    expect(budgeted).toContain('预算用尽');
    expect(budgeted).toContain('收 41 帖');
    expect(budgeted).toContain('另省 12');
    expect(budgeted).toContain('2 页');

    // 读取行的实时动作数只在还在飞的那一行出现：收尾的行报的是结论，不是「滑动了几次」。
    const active = byLabel('status/19590');
    expect(active).toContain('等待中');
    // 段落（spec §5.4 的 phaseDetail）与状态词连着读：「等待中 · 读回复」。
    expect(active).toContain('读回复');
    expect(active).toContain('根帖 + 0 回复');
    expect(active).toContain('请求中');
    expect(active).toContain('展开 18 · 滚动 6');
    const observedRead = byLabel('status/19581');
    expect(observedRead).toContain('有正文');
    expect(observedRead).not.toContain('展开');
    // 收尾的行没有段落可说：主进程收尾时清空 `phaseDetail`，卡上也不该留一个词。
    expect(phaseDetails(mounted.tree).map(visibleText)).toEqual(['读回复']);
    expect(observedRead).not.toContain('读回复');
    expect(byLabel('status/19583')).toContain('文章失败');

    // 排队那一行只说状态与「这次没要文章」：帖数 / 根帖 / 动作数都是还没发生的事。
    const queued = byLabel('status/19595');
    expect(queued).toContain('排队');
    expect(queued).toContain('无文章');
    expect(queued).not.toContain('根帖');
    expect(queued).not.toContain('展开');
  });

  it('shows stateReason only when it explains the state', async () => {
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 1, state: 'completed',
      stateReason: 'cancelled' }));
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();
    expect(visibleText(mounted.find('x-research-toggle'))).toContain('完成（部分被取消）');

    // 状态词本身就是「取消」时，同一件事不再括注一遍。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 2, state: 'cancelled',
      stateReason: 'cancelled' }));
    mounted.rerender(props);
    const header = visibleText(mounted.find('x-research-toggle'));
    expect(header).toContain('X 研究 · 取消');
    expect(header).not.toContain('（');
  });

  it('states a queued or settled article obligation without claiming action', async () => {
    useXResearchTaskStore.getState().upsert(snapshot({ read: [
      workItem({ section: 'read', label: 'queued-target', state: 'queued', article: 'pending' }),
      // 收尾了却没走到取文章那一步：`article` 不会被 `concludeRow` 收尾，它停在 `pending`。
      workItem({ section: 'read', label: 'settled-target', state: 'stopped', status: 'access_denied',
        article: 'pending' }),
      workItem({ section: 'read', label: 'live-target', state: 'collecting', article: 'pending',
        phaseDetail: 'article' }),
    ] }));
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();
    const byLabel = (label: string) => rows(mounted.tree).map(visibleText)
      .find((text) => text.includes(label))!;

    // 排队行只能说义务：`排队 请求中` 是讲一件还没发生的事（进行时）。
    const queued = byLabel('queued-target');
    expect(queued).toContain('排队');
    expect(queued).toContain('待取');
    expect(queued).not.toContain('请求中');
    // 收尾的行再说「请求中」等于承诺一件再也不会发生的事：它没走到取文章那一步，只剩义务。
    const settled = byLabel('settled-target');
    expect(settled).toContain('访问被拒');
    expect(settled).toContain('待取');
    expect(settled).not.toContain('请求中');
    // 对照：真在飞的那一行还在取，说「请求中」；它的段落（读文章）与状态词连着读。
    const live = byLabel('live-target');
    expect(live).toContain('收集中');
    expect(live).toContain('请求中');
    expect(live).not.toContain('待取');
    expect(live).toContain('读文章');
    // 段落 span 只有那一个：三行里两行 `phaseDetail: null`，一行 `article`。
    expect(phaseDetails(mounted.tree).map(visibleText)).toEqual(['读文章']);
  });

  it('offers cancel while work is still queued or running, whatever the state word says', async () => {
    // `interrupted` 是黏的：一份失败的提交把它留在盘上，而往同一段研究追加的工作可能正在跑。
    // 卡上的取消入口因此不能只认状态词 —— 认它就会在一段**正在采集**的研究上把按钮藏掉，
    // 用户没有任何办法停下它（「停止」按钮只中止 agent 回合，spec §4.7）。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 1, state: 'interrupted',
      counts: { ...running.counts, queued: 0, running: 1, interrupted: 1 } }));
    const collecting = mount(XResearchProgressCard, props);
    await collecting.settle();
    expect(collecting.query('x-research-cancel')).not.toBeNull();

    // 翻面：同一张卡，活干完了（中断仍留在状态词上）—— 没有可停的东西，入口消失。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 2, state: 'interrupted',
      counts: { ...running.counts, queued: 0, running: 0, interrupted: 1 } }));
    collecting.rerender(props);
    expect(collecting.query('x-research-cancel')).toBeNull();
  });

  it('keeps a row that stopped without a conclusion free of its numbers', async () => {
    // 进程被杀留下的行是 `stopped` + `status: null`（没有节流落盘，spec §4.4）：计数停在最后一次
    // 落盘上，`收 0 帖` / `无根帖` 会把一份没人观测到的残缺当结论。行自己已经说「中断」。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 1, state: 'running', search: [
      workItem({ section: 'search', label: 'interrupted-query', state: 'stopped', status: null }),
      workItem({ section: 'search', label: 'observed-query', product: 'Top', state: 'stopped',
        status: 'observed', posts: 87, pages: 3 }),
      workItem({ section: 'search', label: 'live-query', state: 'collecting', posts: 5 }),
    ], read: [
      workItem({ section: 'read', label: 'interrupted-target', state: 'stopped', status: null }),
      workItem({ section: 'read', label: 'observed-target', state: 'stopped', status: 'observed',
        hasRoot: true, replies: 42, article: 'body' }),
    ] }));
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();
    const byLabel = (label: string) => rows(mounted.tree).map(visibleText)
      .find((text) => text.includes(label))!;

    expect(byLabel('interrupted-query')).toContain('中断');
    expect(byLabel('interrupted-query')).not.toContain('收 0 帖');
    expect(byLabel('interrupted-target')).toContain('中断');
    expect(byLabel('interrupted-target')).not.toContain('无根帖');
    expect(byLabel('interrupted-target')).not.toContain('根帖');
    // 正控（同一条用例里）：有结论的行与还在飞的行照常报数 —— 上面两条不是「整段都不报数」。
    expect(byLabel('observed-query')).toContain('收 87 帖');
    expect(byLabel('live-query')).toContain('收 5 帖');
    expect(byLabel('observed-target')).toContain('根帖 + 42 回复');
  });

  it('asks for confirmation before cancelling and does nothing when declined', async () => {
    useXResearchTaskStore.getState().upsert(running);
    invoke.mockImplementation(async (method) => method === 'xResearch.taskCancel'
      ? snapshot({ revision: 2, state: 'cancelled' }) : running);
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();

    mounted.find('x-research-cancel').props.onClick();
    await vi.waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
    const request = useConfirmStore.getState().request!;
    expect(request.title).toBe('取消这段 X 研究？');
    expect(request.confirmLabel).toBe('取消研究');
    expect(request.message).toContain('已收集的帖子');

    useConfirmStore.getState().resolve(false);
    await mounted.settle();
    expect(invoke).not.toHaveBeenCalledWith('xResearch.taskCancel', props);

    mounted.find('x-research-cancel').props.onClick();
    await vi.waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
    useConfirmStore.getState().resolve(true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('xResearch.taskCancel', props));

    // 终态不再给取消入口（上一段已经证明它在运行中是有的）。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 2, state: 'cancelled' }));
    mounted.rerender(props);
    expect(mounted.query('x-research-cancel')).toBeNull();
  });

  it('reloads the snapshot on mount and distinguishes a deleted run from an unwired service', async () => {
    invoke.mockRejectedValue(Object.assign(new Error('X research task not found'),
      { code: 'research.not_found' }));
    const deleted = mount(XResearchProgressCard, props);
    await deleted.settle();
    expect(invoke).toHaveBeenCalledWith('xResearch.taskGet', props);
    // 不是错误（不弹红字），但也不能永远停在「读取中」：研究真的不在了，卡头直说。
    expect(deleted.query('x-research-error')).toBeNull();
    expect(visibleText(deleted.find('x-research-toggle'))).toContain('X 研究 · 记录不可用');
    expect(deleted.find('x-research-card').props['data-status']).toBe('missing');

    // 第二条分支：**服务还没接上**（x research 开关默认关闭）。它不是一个结论，
    // 所以不 latch「记录不可用」—— 否则服务一接上、快照一到位，卡头还是那句话。
    invoke.mockRejectedValue(Object.assign(new Error('X research task service is not wired'),
      { code: 'research.unavailable' }));
    const unwired = mount(XResearchProgressCard, props);
    await unwired.settle();
    expect(unwired.query('x-research-error')).toBeNull();
    expect(unwired.find('x-research-card').props['data-status']).toBe('loading');
    expect(visibleText(unwired.find('x-research-toggle'))).toContain('X 研究 · 读取中');
    // 对照：同一条用例里刚证明过的「记录不可用」不能出现在这一支上。
    expect(visibleText(unwired.find('x-research-toggle'))).not.toContain('记录不可用');

    // 第三条分支：别的失败要看得见（同一条用例里的正面对照：「删掉的研究」被吞掉）。
    invoke.mockRejectedValue(Object.assign(new Error('IPC 断了'), { code: 'fs.read_failed' }));
    const broken = mount(XResearchProgressCard, props);
    await broken.settle();
    expect(visibleText(broken.find('x-research-error'))).toContain('IPC 断了');
    // 对照：别的失败不是「记录不可用」，卡头仍是未知状态里那个「读取中」。
    expect(broken.find('x-research-card').props['data-status']).toBe('loading');
    expect(visibleText(broken.find('x-research-toggle'))).toContain('X 研究 · 读取中');

    // 第四条分支：`research.not_found` 对「这个窗口当时没在看这条对话」只是一个**瞬时**事实，
    // 不许把「记录不可用」锁死。补取路径还开着（这里是 `unavailable` 那条：它要有一次成功才
    // 会关掉），所以取到一次成功就得把这个锁清掉 —— 清不掉的话，下一次行从池里消失时「一次性
    // 补取」会被这个锁挡在门外，卡永远停在「记录不可用」。
    useXResearchTaskStore.getState().reset(props.threadId);
    invoke.mockRejectedValue(Object.assign(new Error('X research task service is not wired'),
      { code: 'research.unavailable' }));
    const transient = mount(XResearchProgressCard, props);
    await transient.settle();
    // 补取这一次答「不在这个窗口」：锁置上，但 `unavailable` 还没被关掉，补取仍在武装状态。
    invoke.mockRejectedValue(Object.assign(new Error('X research task not found'),
      { code: 'research.not_found' }));
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 1 }));
    transient.rerender(props);
    await transient.settle();
    // 再补一次，这次成功：锁该清掉。
    invoke.mockResolvedValue(running);
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 2 }));
    transient.rerender(props);
    await transient.settle();
    // 池里那一行没了：一次性补取还在，卡必须回到真内容 —— 锁若还锁着，这里会是「记录不可用」。
    useXResearchTaskStore.getState().reset(props.threadId);
    transient.rerender(props);
    await transient.settle();
    // 补取的结果落进了池里，重渲染一次才看得见（与上一条用例同一个读法）。
    transient.rerender(props);
    expect(transient.find('x-research-card').props['data-status']).toBe('running');
  });

  it('keeps 读取中 while the service is unwired and refetches once a snapshot arrives', async () => {
    invoke.mockRejectedValue(Object.assign(new Error('X research task service is not wired'),
      { code: 'research.unavailable' }));
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();
    expect(mounted.find('x-research-card').props['data-status']).toBe('loading');
    expect(mounted.query('x-research-summary')).toBeNull();
    expect(taskGetCalls()).toBe(1);

    // store 里出现了这份 run 的快照（广播或 resync 到了）：补取一次。
    // 补回来的那一份 revision 更高、状态也不同，所以卡面只能来自**补取的结果**。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 1, state: 'running' }));
    invoke.mockResolvedValue(snapshot({ revision: 7, state: 'failed', stateReason: 'cancelled' }));
    mounted.rerender(props);
    await mounted.settle();
    mounted.rerender(props);

    expect(taskGetCalls()).toBe(2);
    expect(mounted.find('x-research-card').props['data-status']).toBe('failed');
    expect(visibleText(mounted.find('x-research-toggle'))).toContain('有失败（部分被取消）');
    // 真内容出来了：那一行摘要就是卡面在「服务接上」前后的差别。
    expect(visibleText(mounted.find('x-research-summary'))).toContain('收 128 帖');
  });

  it('refetches once when the store drops the row after it had been read', async () => {
    // 挂载时 store 里还没有这一行：内容来自挂载那次 taskGet（它把快照 upsert 回池里）。
    expect(useXResearchTaskStore.getState().snapshotsByRunId['xrun-a']).toBeUndefined();
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();
    mounted.rerender(props);
    expect(rows(mounted.tree)).toHaveLength(6);
    expect(taskGetCalls()).toBe(1);

    // `taskList` 的整批替换在这条研究落盘之前就扫完了：它没见过的那一行被删掉。
    useXResearchTaskStore.getState().reset(props.threadId);
    mounted.rerender(props);
    expect(mounted.query('x-research-summary')).toBeNull();
    await mounted.settle();
    mounted.rerender(props);
    // 补取了一次，卡面回到真内容，而不是永远停在「读取中」。
    expect(taskGetCalls()).toBe(2);
    expect(visibleText(mounted.find('x-research-toggle'))).toContain('X 研究 · 进行中');
    expect(rows(mounted.tree)).toHaveLength(6);

    // 第二次消失不再补取：真被删掉的研究（或一直扫不到它的 resync）不能变成死循环。
    useXResearchTaskStore.getState().reset(props.threadId);
    mounted.rerender(props);
    await mounted.settle();
    expect(taskGetCalls()).toBe(2);
    expect(visibleText(mounted.find('x-research-toggle'))).toContain('X 研究 · 读取中');
  });

  it('leaves a section with no targets out of the summary', async () => {
    // 一次纯读取的研究：搜索段一行都没有，卡头不该说「搜索 0/0 个 query」。
    const readOnly = snapshot({ search: [],
      counts: { ...snapshot().counts, searchDone: 0, searchTotal: 0, posts: 0 } });
    invoke.mockResolvedValue(readOnly);
    useXResearchTaskStore.getState().upsert(readOnly);
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();

    const readOnlySummary = visibleText(mounted.find('x-research-summary'));
    expect(readOnlySummary).toContain('读取 1/4 个目标');
    expect(readOnlySummary).not.toContain('搜索');
    expect(readOnlySummary).not.toContain('收 0 帖');

    // 同一条用例里的正面对照：两段都有行的研究照常把两段都写出来（上一条不是「搜索永远不写」）。
    const both = snapshot({ revision: 2 });
    invoke.mockResolvedValue(both);
    useXResearchTaskStore.getState().upsert(both);
    mounted.rerender(props);
    const bothSummary = visibleText(mounted.find('x-research-summary'));
    expect(bothSummary).toContain('搜索 2/2 个 query');
    expect(bothSummary).toContain('收 128 帖');

    // 两段都是 0 行（还没有工作的一项研究）：整行不画，而不是留一个空 div。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 3, search: [], read: [],
      counts: { submissions: 1, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0,
        interrupted: 0, posts: 0, replies: 0, articles: 0, undelivered: 0,
        searchDone: 0, searchTotal: 0, readDone: 0, readTotal: 0 } }));
    mounted.rerender(props);
    expect(mounted.query('x-research-summary')).toBeNull();
  });
});
