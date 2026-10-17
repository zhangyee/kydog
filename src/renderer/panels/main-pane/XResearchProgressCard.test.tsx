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
  return {
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
    ...over,
  };
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

  it('states a queued article obligation without claiming action', async () => {
    useXResearchTaskStore.getState().upsert(snapshot({ read: [
      workItem({ section: 'read', label: 'queued-target', state: 'queued', article: 'pending' }),
      workItem({ section: 'read', label: 'live-target', state: 'collecting', article: 'pending' }),
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
    // 对照：真在飞的那一行还在取，说「请求中」；它没有段落可报时也不编一个词。
    const live = byLabel('live-target');
    expect(live).toContain('收集中');
    expect(live).toContain('请求中');
    expect(live).not.toContain('待取');
    expect(phaseDetails(mounted.tree).map(visibleText)).toEqual([]);
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

  it('reloads the snapshot on mount and swallows a deleted run', async () => {
    invoke.mockRejectedValue(Object.assign(new Error('X research task not found'),
      { code: 'research.not_found' }));
    const gone = mount(XResearchProgressCard, props);
    await gone.settle();
    expect(invoke).toHaveBeenCalledWith('xResearch.taskGet', props);
    // 不是错误（不弹红字），但也不能永远停在「读取中」：那个 code 也盖着「任务服务没接上」。
    expect(gone.query('x-research-error')).toBeNull();
    expect(visibleText(gone.find('x-research-toggle'))).toContain('X 研究 · 记录不可用');
    expect(gone.find('x-research-card').props['data-status']).toBe('missing');

    // 同一条用例里的正面对照：「删掉的研究」被吞掉，别的失败要看得见。
    invoke.mockRejectedValue(Object.assign(new Error('IPC 断了'), { code: 'fs.read_failed' }));
    const broken = mount(XResearchProgressCard, props);
    await broken.settle();
    expect(visibleText(broken.find('x-research-error'))).toContain('IPC 断了');
    // 对照：别的失败不是「记录不可用」，卡头仍是未知状态里那个「读取中」。
    expect(broken.find('x-research-card').props['data-status']).toBe('loading');
    expect(visibleText(broken.find('x-research-toggle'))).toContain('X 研究 · 读取中');
  });
});
