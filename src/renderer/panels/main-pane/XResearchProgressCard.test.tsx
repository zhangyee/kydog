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

const props = { threadId: 'thread-1', groupKey: 'xrun-a', researchRunIds: ['xrun-a'] };
/** 卡对单段研究发出的 RPC 参数：卡片级 RPC 仍按研究（`researchRunId`），不按回合。 */
const rpcArgs = { threadId: 'thread-1', researchRunId: 'xrun-a' };
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

// 一条搜索行收尾成「收完」，一条卡在预算上（略过 12 条）；读取行两收尾（读完 / 被登录墙挡住）、
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
    expect(visibleText(mounted.find('x-research-summary'))).toContain('采集 128 帖');
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
    expect(collected).toContain('采集 87 帖');
    // 标签写全：`3 页` 是 `3 页响应` 的子串，只写半截就分不清「翻了几屏」与「几份响应」。
    expect(collected).toContain('3 页响应');
    expect(collected).not.toContain('略过');

    const budgeted = byLabel('Qwen3.8 Q4 量化');
    expect(budgeted).toContain('Latest');
    expect(budgeted).toContain('预算用尽');
    expect(budgeted).toContain('采集 41 帖');
    expect(budgeted).toContain('略过 12 条');
    expect(budgeted).toContain('2 页响应');

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

  it('says who cancelled when the snapshot knows', async () => {
    // 旧数据（没有 `cancelledBy`）走的仍是今天那句措辞 —— 这里的第一帧就是那个形状。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 2, state: 'cancelled',
      stateReason: 'cancelled' }));
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();
    expect(visibleText(mounted.find('x-research-toggle'))).toContain('X 研究 · 取消');

    // 模型自己停的：不许写成无主语的「被取消」。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 3, state: 'completed',
      stateReason: 'cancelled', cancelledBy: 'agent' }));
    mounted.rerender(props);
    expect(visibleText(mounted.find('x-research-toggle'))).toContain('完成（模型中途取消）');

    // 用户按的取消说「你」：两个主语各自一句话（翻面：同一条理由换主语就跟着换）。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 4, state: 'cancelled',
      stateReason: 'cancelled', cancelledBy: 'user' }));
    mounted.rerender(props);
    expect(visibleText(mounted.find('x-research-toggle'))).toContain('取消（你中途取消）');
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

  it('opens a round header for every submission of a section, in order, with numbering continuous', async () => {
    // 现场形状（一张卡里一段研究跑了四次提交）：搜 5、补搜 3、读 3、补读 2。同一次提交的行
    // `submissionId` 相同 —— 卡按它切轮，不靠时间窗或阈值。
    const roundOf = (submissionId: string, section: XResearchWorkItem['section'], labels: string[]) =>
      labels.map((label) => workItem({ submissionId, section, label, state: 'stopped',
        status: 'observed', posts: 10, hasRoot: section === 'read', replies: 1 }));
    const fourRounds = snapshot({
      researchRunId: 'xrun-rounds', runId: 'turn-rounds', objective: '一场四轮的研究',
      counts: { submissions: 4, queued: 0, running: 0, done: 13, failed: 0, cancelled: 0,
        interrupted: 0, posts: 80, replies: 5, articles: 0, undelivered: 0,
        searchDone: 8, searchTotal: 8, readDone: 5, readTotal: 5 },
      search: [...roundOf('sub-s1', 'search', ['s1', 's2', 's3', 's4', 's5']),
        ...roundOf('sub-s2', 'search', ['s6', 's7', 's8'])],
      read: [...roundOf('sub-r1', 'read', ['r1', 'r2', 'r3']),
        ...roundOf('sub-r2', 'read', ['r4', 'r5'])],
    });
    useXResearchTaskStore.getState().upsert(fourRounds);
    invoke.mockResolvedValue(fourRounds);
    const mounted = mount(XResearchProgressCard,
      { threadId: 'thread-1', groupKey: 'turn-rounds', researchRunIds: ['xrun-rounds'] });
    await mounted.settle();

    const headers = findAllWhere(mounted.tree,
      (element) => element.props['data-testid'] === 'x-research-round');
    // 两段各两轮：先说的这一轮是首个提交，后面的都是往同一段研究里补的步骤。
    expect(headers.map(visibleText)).toEqual([
      '第 1 轮 · 5 个 query', '第 2 轮 · 补搜 3 个 query',
      '第 1 轮 · 3 个目标', '第 2 轮 · 补读 2 个目标',
    ]);
    expect(headers.map((header) => header.props['data-operation']))
      .toEqual(['search', 'search', 'read', 'read']);
    // `data-round` 是**这一段里**第几次提交（两段各自从 1 起）。
    expect(headers.map((header) => header.props['data-round'])).toEqual([1, 2, 1, 2]);
    expect(rows(mounted.tree)).toHaveLength(13);

    // 行必须在自己那一轮的头之后、下一轮的头之前；编号在段内连续（第二轮接着 ⑥⑦⑧，不从 ① 重来）。
    const inOrder = (text: string, parts: string[]) => parts.map((part) => {
      const at = text.indexOf(part);
      expect(at, `${part} 不在这一段里：${text}`).toBeGreaterThanOrEqual(0);
      return at;
    });
    const search = inOrder(visibleText(mounted.find('x-research-search')), [
      '第 1 轮 · 5 个 query', '①', 's1', '②', 's2', '③', 's3', '④', 's4', '⑤', 's5',
      '第 2 轮 · 补搜 3 个 query', '⑥', 's6', '⑦', 's7', '⑧', 's8',
    ]);
    expect(search).toEqual([...search].sort((a, b) => a - b));
    const read = inOrder(visibleText(mounted.find('x-research-read')), [
      '第 1 轮 · 3 个目标', '①', 'r1', '②', 'r2', '③', 'r3',
      '第 2 轮 · 补读 2 个目标', '④', 'r4', '⑤', 'r5',
    ]);
    expect(read).toEqual([...read].sort((a, b) => a - b));

    // 对照（同一条用例）：只有一轮的一段**不画**轮次头 —— 「总是画一个轮次头」在这里就红了。
    const oneRound = snapshot({ researchRunId: 'xrun-one', runId: 'turn-one',
      objective: '只有一轮的一段',
      search: roundOf('sub-only', 'search', ['only-1', 'only-2']),
      read: roundOf('sub-only-r', 'read', ['only-r1']) });
    useXResearchTaskStore.getState().upsert(oneRound);
    invoke.mockResolvedValue(oneRound);
    const single = mount(XResearchProgressCard,
      { threadId: 'thread-1', groupKey: 'turn-one', researchRunIds: ['xrun-one'] });
    await single.settle();
    expect(findAllWhere(single.tree,
      (element) => element.props['data-testid'] === 'x-research-round')).toHaveLength(0);
    // 单轮与今天的行文本一样：① 起头，行自己的数字不变。
    expect(visibleText(single.find('x-research-search'))
      .startsWith('搜索①only-1')).toBe(true);
    expect(visibleText(single.find('x-research-read')).startsWith('读取①only-r1')).toBe(true);
  });

  /** 一份提交（一轮）的夹具：快照的 `rounds` 那一项 + 它的行。行上写着同一个 `submissionId` ——
   *  真快照里那一格由投影从拥有它的提交盖上（`xResearchTaskSnapshot`），夹具照抄一遍。 */
  function roundPart(submissionId: string, operation: 'search' | 'read', objective: string,
    labels: string[], over: { state?: 'done' | 'cancelled'; at?: string } = {}) {
    const state = over.state ?? 'done';
    return {
      round: {
        submissionId, operation, objective, state, createdAt: over.at ?? '2026-10-16T00:00:00.000Z',
        // 被取消的那一轮带归因（R81a）：卡上的章说的是「谁停的」，不是无主语的「被取消」。
        ...(state === 'cancelled' ? { stateReason: 'cancelled', cancelledBy: 'agent' as const } : {}),
      },
      rows: labels.map((label) => workItem({
        submissionId, section: operation, label, state: 'stopped',
        status: state === 'cancelled' ? 'cancelled' : 'observed',
        posts: operation === 'search' ? 10 : 0,
        hasRoot: operation === 'read', replies: operation === 'read' ? 1 : 0,
      })),
    };
  }

  const roundsOf = (parts: ReturnType<typeof roundPart>[], section: 'search' | 'read') =>
    parts.filter((part) => part.round.operation === section).flatMap((part) => part.rows);

  it('cuts the turn into segments by objective: one segment per goal, rounds inside, across researches too', async () => {
    // 现场形状（R83）：一次「macOS 轻量虚拟化」的研究里，模型取消后接着补搜、又换了目标补读引信。
    // 卡按 **objective** 切段（不是按研究）：同一个目标的连续几轮是一段，换目标才开新段。
    const parts = [
      roundPart('sub-a1', 'search', 'macOS 轻量虚拟化', ['s1', 's2', 's3', 's4', 's5'],
        { at: '2026-10-16T00:01:00.000Z' }),
      roundPart('sub-a2', 'search', 'macOS 轻量虚拟化', ['s6', 's7', 's8'],
        { at: '2026-10-16T00:02:00.000Z' }),
      roundPart('sub-b1', 'read', '补读引信', ['r1', 'r2', 'r3'], { at: '2026-10-16T00:03:00.000Z' }),
      roundPart('sub-b2', 'read', '补读引信', ['r4', 'r5'], { at: '2026-10-16T00:04:00.000Z' }),
    ];
    const twoGoals = snapshot({
      researchRunId: 'xrun-goals', runId: 'turn-goals', objective: 'macOS 轻量虚拟化', state: 'completed',
      rounds: parts.map((part) => part.round),
      counts: { submissions: 4, queued: 0, running: 0, done: 13, failed: 0, cancelled: 0,
        interrupted: 0, posts: 80, replies: 5, articles: 0, undelivered: 0,
        searchDone: 8, searchTotal: 8, readDone: 5, readTotal: 5 },
      search: roundsOf(parts, 'search'), read: roundsOf(parts, 'read'),
    });
    useXResearchTaskStore.getState().upsert(twoGoals);
    invoke.mockResolvedValue(twoGoals);
    const mounted = mount(XResearchProgressCard,
      { threadId: 'thread-1', groupKey: 'turn-goals', researchRunIds: ['xrun-goals'] });
    await mounted.settle();
    // 终态默认收起：展开才看得见段与轮（它们属于行那一段，不是卡头）。
    mounted.find('x-research-toggle').props.onClick();

    const objectives = (node: unknown) => findAllWhere(node,
      (element) => element.props['data-testid'] === 'x-research-segment')
      .map((header) => header.props.children[0].props.children[2].props.children);
    const roundHeaders = (node: unknown) => findAllWhere(node,
      (element) => element.props['data-testid'] === 'x-research-round');
    const segments = findAllWhere(mounted.tree,
      (element) => element.props['data-testid'] === 'x-research-segment');
    // 一段研究、两个目标 → 两个分段：搜索那两轮一段，补读那两轮一段。
    expect(segments.map((segment) => segment.props['data-status'])).toEqual(['completed', 'completed']);
    expect(objectives(mounted.tree)).toEqual(['macOS 轻量虚拟化', '补读引信']);
    // 轮次头在各自那一段里，编号在段内连续（第二轮接着第一轮数下去）。
    expect(roundHeaders(segments[0]).map(visibleText))
      .toEqual(['第 1 轮 · 5 个 query', '第 2 轮 · 补搜 3 个 query']);
    expect(roundHeaders(segments[1]).map(visibleText))
      .toEqual(['第 1 轮 · 3 个目标', '第 2 轮 · 补读 2 个目标']);
    expect(rows(segments[0])).toHaveLength(8);
    expect(rows(segments[1])).toHaveLength(5);
    // 卡头的数字与副标题不因为分段而变：仍是各段真实计数的合计、仍是最早一次提交的目标（R10）。
    expect(visibleText(mounted.find('x-research-objective'))).toBe('macOS 轻量虚拟化');
    const summary = visibleText(mounted.find('x-research-summary'));
    expect(summary).toContain('搜索 8/8 个 query · 采集 80 帖');
    expect(summary).toContain('读取 5/5 个目标 · 5 回复 · 文章 0 篇');

    // 对照（同一条用例）：**同一个目标横跨两段研究**（取消后重开 / 接着做）→ 一段，不是两段。
    // 这就是这次要修的那件事：三段「残骸」其实是同一个目标下的三轮。
    const cancelledPart = roundPart('sub-c1', 'search', '取消后接着做的那个目标', ['c1'],
      { state: 'cancelled', at: '2026-10-16T00:05:00.000Z' });
    const continuedPart = roundPart('sub-c2', 'search', '取消后接着做的那个目标', ['c2'],
      { at: '2026-10-16T00:06:00.000Z' });
    const cancelledRun = snapshot({
      researchRunId: 'xrun-fork-a', runId: 'turn-fork', objective: '取消后接着做的那个目标',
      state: 'cancelled', stateReason: 'cancelled', cancelledBy: 'agent',
      createdAt: '2026-10-16T00:05:00.000Z',
      rounds: [cancelledPart.round], search: roundsOf([cancelledPart], 'search'), read: [],
      counts: { submissions: 1, queued: 0, running: 0, done: 0, failed: 0, cancelled: 1,
        interrupted: 0, posts: 10, replies: 0, articles: 0, undelivered: 0,
        searchDone: 1, searchTotal: 1, readDone: 0, readTotal: 0 },
    });
    const continuedRun = snapshot({
      researchRunId: 'xrun-fork-b', runId: 'turn-fork', objective: '取消后接着做的那个目标',
      state: 'completed', createdAt: '2026-10-16T00:06:00.000Z',
      rounds: [continuedPart.round], search: roundsOf([continuedPart], 'search'), read: [],
      counts: { submissions: 1, queued: 0, running: 0, done: 1, failed: 0, cancelled: 0,
        interrupted: 0, posts: 10, replies: 0, articles: 0, undelivered: 0,
        searchDone: 1, searchTotal: 1, readDone: 0, readTotal: 0 },
    });
    useXResearchTaskStore.setState({ snapshotsByRunId: {
      'xrun-fork-a': cancelledRun, 'xrun-fork-b': continuedRun,
    } });
    invoke.mockResolvedValue(cancelledRun);
    const forked = mount(XResearchProgressCard,
      { threadId: 'thread-1', groupKey: 'turn-fork', researchRunIds: ['xrun-fork-a', 'xrun-fork-b'] });
    await forked.settle();
    forked.find('x-research-toggle').props.onClick();

    // 两段研究、一个目标 → **一段**。终态按**轮**算：一轮取消 + 一轮完成 = 完成（取消的是其中一轮）。
    const merged = findAllWhere(forked.tree,
      (element) => element.props['data-testid'] === 'x-research-segment');
    expect(merged).toHaveLength(1);
    expect(merged[0].props['data-status']).toBe('completed');
    expect(objectives(forked.tree)).toEqual(['取消后接着做的那个目标']);
    // 两轮都在这段里，被取消的那一轮留着并带着章（R83）：卡不把停下的那一轮从经过里抹掉。
    expect(roundHeaders(merged[0]).map(visibleText))
      .toEqual(['第 1 轮 · 1 个 query已取消（模型中途取消）', '第 2 轮 · 补搜 1 个 query']);
    expect(rows(merged[0])).toHaveLength(2);
  });

  it('renders rows from before submissionId exactly like a single-round section', async () => {
    // 旧数据（这个字段之前落的盘）：分不出轮次，卡退回今天的样子 —— 不猜一个轮次，也不画头。
    useXResearchTaskStore.getState().upsert(running);
    const old = mount(XResearchProgressCard, props);
    await old.settle();
    expect(findAllWhere(old.tree,
      (element) => element.props['data-testid'] === 'x-research-round')).toHaveLength(0);
    expect(rows(old.tree).map(visibleText)).toHaveLength(6);

    // 同一批行带上属于同一份提交的 `submissionId`（也就是一轮）：两段的文本逐字相同。
    const stamped = snapshot({ researchRunId: 'xrun-stamped', runId: 'turn-stamped',
      objective: '同一批行加上提交 id',
      search: SEARCH_ROWS.map((row) => ({ ...row, submissionId: 'sub-old' })),
      read: READ_ROWS.map((row) => ({ ...row, submissionId: 'sub-old' })) });
    useXResearchTaskStore.getState().upsert(stamped);
    invoke.mockResolvedValue(stamped);
    const withIds = mount(XResearchProgressCard,
      { threadId: 'thread-1', groupKey: 'turn-stamped', researchRunIds: ['xrun-stamped'] });
    await withIds.settle();
    expect(findAllWhere(withIds.tree,
      (element) => element.props['data-testid'] === 'x-research-round')).toHaveLength(0);
    expect(visibleText(withIds.find('x-research-search')))
      .toBe(visibleText(old.find('x-research-search')));
    expect(visibleText(withIds.find('x-research-read')))
      .toBe(visibleText(old.find('x-research-read')));
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

  it('renders one card for a whole turn: a segment header per research, in createdAt order, each with its own terminal chip', async () => {
    const cancelled = snapshot({
      researchRunId: 'xrun-cancelled', runId: 'turn-1', objective: '模型取消的那一段',
      createdAt: '2026-10-16T00:00:01.000Z', state: 'cancelled', stateReason: 'cancelled',
      cancelledBy: 'agent',
      counts: { submissions: 1, queued: 0, running: 0, done: 0, failed: 0, cancelled: 1,
        interrupted: 0, posts: 7, replies: 0, articles: 0, undelivered: 0,
        searchDone: 1, searchTotal: 1, readDone: 0, readTotal: 0 },
      budget: { scrolls: 40, expandActions: 10 }, usage: { posts: 7, scrolls: 3, expandActions: 1 },
      search: [workItem({ section: 'search', label: '取消前收完的 query', state: 'stopped',
        status: 'observed', posts: 7 })],
      read: [],
    });
    const failed = snapshot({
      researchRunId: 'xrun-failed', runId: 'turn-1', objective: '全灭的那一段',
      createdAt: '2026-10-16T00:00:02.000Z', state: 'failed',
      counts: { submissions: 1, queued: 0, running: 0, done: 0, failed: 1, cancelled: 0,
        interrupted: 0, posts: 0, replies: 0, articles: 0, undelivered: 0,
        searchDone: 0, searchTotal: 0, readDone: 1, readTotal: 1 },
      budget: { scrolls: 50, expandActions: 20 }, usage: { posts: 0, scrolls: 5, expandActions: 2 },
      search: [],
      read: [workItem({ section: 'read', label: 'https://x.com/acme/status/failed',
        state: 'stopped', status: 'failed', reason: '源侧拒绝' })],
    });
    const completed = snapshot({
      researchRunId: 'xrun-completed', runId: 'turn-1', objective: '重试成功的那一段',
      createdAt: '2026-10-16T00:00:03.000Z', state: 'completed',
      counts: { submissions: 1, queued: 0, running: 0, done: 2, failed: 0, cancelled: 0,
        interrupted: 0, posts: 10, replies: 4, articles: 1, undelivered: 0,
        searchDone: 1, searchTotal: 1, readDone: 1, readTotal: 1 },
      budget: { scrolls: 60, expandActions: 30 }, usage: { posts: 10, scrolls: 1, expandActions: 0 },
      search: [workItem({ section: 'search', label: '重试的 query', state: 'stopped',
        status: 'observed', posts: 10 })],
      read: [workItem({ section: 'read', label: 'https://x.com/acme/status/ok',
        state: 'stopped', status: 'observed', hasRoot: true, replies: 4, article: 'body' })],
    });
    // 池子里故意乱序放：分组与段序只能来自 `createdAt`，不能来自写入次序。
    useXResearchTaskStore.setState({ snapshotsByRunId: {
      'xrun-completed': completed, 'xrun-failed': failed, 'xrun-cancelled': cancelled,
    } });
    invoke.mockResolvedValue(cancelled);
    const groupProps = { threadId: 'thread-1', groupKey: 'turn-1',
      researchRunIds: ['xrun-cancelled', 'xrun-failed', 'xrun-completed'] };
    const mounted = mount(XResearchProgressCard, groupProps);
    await mounted.settle();

    expect(mounted.find('x-research-card').props['data-status']).toBe('cancelled');
    // 段间结论不一致时，卡头补一句「3 段：…」—— 否则「取消后重试成功」的回合只看得到「取消」。
    expect(visibleText(mounted.find('x-research-toggle')))
      .toContain('3 段：1 取消 / 1 有失败 / 1 完成');
    // 卡头副标题取最早一段的目标（R10），合并不能让它换题。
    expect(visibleText(mounted.find('x-research-objective'))).toBe('模型取消的那一段');
    // 三段都是终态：卡默认收起，展开才看得见分段头。
    mounted.find('x-research-toggle').props.onClick();
    // 三个分段头，按 createdAt 升序，各自的终态（取消那一段带 R81a 的归因）。
    const headers = findAllWhere(mounted.tree,
      (element) => element.props['data-testid'] === 'x-research-segment');
    expect(headers.map((header) => header.props['data-status']))
      .toEqual(['cancelled', 'failed', 'completed']);
    expect(headers.map(visibleText)).toEqual([
      expect.stringContaining('取消（模型中途取消）'),
      expect.stringContaining('有失败'),
      expect.stringContaining('完成'),
    ]);
    expect(headers.map((header) => header.props.children[0].props.children[2].props.children))
      .toEqual(['模型取消的那一段', '全灭的那一段', '重试成功的那一段']);
    // 卡头的数字是每段真实计数的合计：7+10 帖、1+1 个 query、1+1 个目标、4 回复、1 篇文章、1 个失败。
    const summary = visibleText(mounted.find('x-research-summary'));
    expect(summary).toContain('搜索 2/2 个 query · 采集 17 帖');
    expect(summary).toContain('读取 2/2 个目标 · 4 回复 · 文章 1 篇');
    expect(summary).toContain('失败 1');
    expect(visibleText(mounted.find('x-research-budget'))).toBe('滚动 9/150 · 展开 3/60');
    // 段内行各自编号、各自归段：三段的搜索行都是 ①（不是跨段连续编号）。
    expect(rows(mounted.tree)).toHaveLength(4);
  });

  it('renders a segment header even when that research has no rows', async () => {
    const withRows = snapshot({ researchRunId: 'xrun-a', runId: 'turn-1', objective: '有行的一段',
      createdAt: '2026-10-16T00:00:01.000Z' });
    const empty = snapshot({ researchRunId: 'xrun-b', runId: 'turn-1', objective: '崩溃前没落下行的一段',
      createdAt: '2026-10-16T00:00:02.000Z', state: 'interrupted', stateReason: 'process_restarted',
      counts: { submissions: 1, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0,
        interrupted: 0, posts: 0, replies: 0, articles: 0, undelivered: 0,
        searchDone: 0, searchTotal: 0, readDone: 0, readTotal: 0 }, search: [], read: [] });
    useXResearchTaskStore.setState({ snapshotsByRunId: { 'xrun-a': withRows, 'xrun-b': empty } });
    invoke.mockResolvedValue(withRows);
    const mounted = mount(XResearchProgressCard,
      { threadId: 'thread-1', groupKey: 'turn-1', researchRunIds: ['xrun-a', 'xrun-b'] });
    await mounted.settle();

    const headers = findAllWhere(mounted.tree,
      (element) => element.props['data-testid'] === 'x-research-segment');
    // 段数要数得出来：没有行的那一段也画自己的头（不能因为空就少一个段）。
    expect(headers).toHaveLength(2);
    expect(headers.map(visibleText)).toEqual([
      expect.stringContaining('有行的一段'), expect.stringContaining('崩溃前没落下行的一段'),
    ]);
    expect(visibleText(headers[1])).toContain('中断（进程重启）');
  });

  it('confirms once and cancels every segment of the turn that still has work', async () => {
    const completed = snapshot({ researchRunId: 'xrun-done', runId: 'turn-1', objective: '已经完成的一段',
      createdAt: '2026-10-16T00:00:01.000Z', state: 'completed' });
    const runningA = snapshot({ researchRunId: 'xrun-a', runId: 'turn-1', objective: '还在跑的一段 A',
      createdAt: '2026-10-16T00:00:02.000Z', state: 'running' });
    const runningB = snapshot({ researchRunId: 'xrun-b', runId: 'turn-1', objective: '还在跑的一段 B',
      createdAt: '2026-10-16T00:00:03.000Z', state: 'running' });
    useXResearchTaskStore.setState({ snapshotsByRunId: {
      'xrun-done': completed, 'xrun-a': runningA, 'xrun-b': runningB,
    } });
    invoke.mockImplementation(async (method, args) => {
      if (method !== 'xResearch.taskCancel') return runningA;
      const { researchRunId } = args as { researchRunId: string };
      return snapshot({ researchRunId, runId: 'turn-1', revision: 2, state: 'cancelled',
        stateReason: 'cancelled', cancelledBy: 'user',
        counts: { ...runningA.counts, queued: 0, running: 0, cancelled: 1 } });
    });
    const mounted = mount(XResearchProgressCard,
      { threadId: 'thread-1', groupKey: 'turn-1', researchRunIds: ['xrun-done', 'xrun-a', 'xrun-b'] });
    await mounted.settle();

    mounted.find('x-research-cancel').props.onClick();
    await vi.waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
    // 确认只弹一次：一次点击 = 一次确认，不是每段弹一个。
    expect(invoke).not.toHaveBeenCalledWith('xResearch.taskCancel', expect.anything());
    useConfirmStore.getState().resolve(true);
    await vi.waitFor(() => expect(invoke)
      .toHaveBeenCalledWith('xResearch.taskCancel', { threadId: 'thread-1', researchRunId: 'xrun-b' }));

    // RPC 仍按研究发：两段还在跑的各自一份，已完成的那一段一份都不发。
    const cancelledIds = invoke.mock.calls
      .filter(([method]) => method === 'xResearch.taskCancel')
      .map(([, args]) => (args as { researchRunId: string }).researchRunId);
    expect(cancelledIds.sort()).toEqual(['xrun-a', 'xrun-b']);
    // 两段都换成取消之后，卡上再没有可停的活：取消入口消失。
    mounted.rerender({ threadId: 'thread-1', groupKey: 'turn-1',
      researchRunIds: ['xrun-done', 'xrun-a', 'xrun-b'] });
    expect(mounted.query('x-research-cancel')).toBeNull();
  });

  it('keeps a row that stopped without a conclusion free of its numbers', async () => {
    // 进程被杀留下的行是 `stopped` + `status: null`（没有节流落盘，spec §4.4）：计数停在最后一次
    // 落盘上，`采集 0 帖` / `无根帖` 会把一份没人观测到的残缺当结论。行自己已经说「中断」。
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
    expect(byLabel('interrupted-query')).not.toContain('采集 0 帖');
    expect(byLabel('interrupted-target')).toContain('中断');
    expect(byLabel('interrupted-target')).not.toContain('无根帖');
    expect(byLabel('interrupted-target')).not.toContain('根帖');
    // 正控（同一条用例里）：有结论的行与还在飞的行照常报数 —— 上面两条不是「整段都不报数」。
    expect(byLabel('observed-query')).toContain('采集 87 帖');
    expect(byLabel('live-query')).toContain('采集 5 帖');
    expect(byLabel('observed-target')).toContain('根帖 + 42 回复');
  });

  it('leaves the header numbers out when a repaired run cannot support them', async () => {
    // 崩溃后修复出来的快照（spec §4.4）：一行收尾却没有结论。它的帖数 / 回复数停在最后一次落盘上，
    // 而 `*Done` 又把它算成收尾 —— `采集 N 帖` 漏了它、`N/M` 说它已经有结论，两个数字都是没人观测
    // 到的。那一节的数字整段不出现，结论只由那一行自己说（行内同一条判据，见上一条用例）。
    const repaired = snapshot({
      revision: 1, state: 'interrupted',
      counts: { submissions: 1, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0,
        interrupted: 1, posts: 0, replies: 0, articles: 0, undelivered: 0,
        searchDone: 1, searchTotal: 1, readDone: 0, readTotal: 0 },
      search: [workItem({ section: 'search', label: 'crashed-query', state: 'stopped', status: null })],
      read: [],
    });
    invoke.mockResolvedValue(repaired);
    useXResearchTaskStore.getState().upsert(repaired);
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();

    expect(mounted.find('x-research-card').props['data-status']).toBe('interrupted');
    expect(visibleText(mounted.find('x-research-toggle'))).toContain('X 研究 · 中断');
    // 两个都不画：没有「收 N 帖」，也没有「N/M」—— 连那一行摘要本身都不出现（两段都没东西可说）。
    expect(mounted.query('x-research-summary')).toBeNull();

    // 同一条用例里的正控：换成真有结论的那一份（同样的渲染路径），两个数字都回来。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 2 }));
    mounted.rerender(props);
    const summary = visibleText(mounted.find('x-research-summary'));
    expect(summary).toContain('采集 128 帖');
    expect(summary).toContain('搜索 2/2 个 query');
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
    expect(invoke).not.toHaveBeenCalledWith('xResearch.taskCancel', rpcArgs);

    mounted.find('x-research-cancel').props.onClick();
    await vi.waitFor(() => expect(useConfirmStore.getState().request).not.toBeNull());
    useConfirmStore.getState().resolve(true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('xResearch.taskCancel', rpcArgs));

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
    expect(invoke).toHaveBeenCalledWith('xResearch.taskGet', rpcArgs);
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
    expect(visibleText(mounted.find('x-research-summary'))).toContain('采集 128 帖');
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
    expect(readOnlySummary).not.toContain('采集 0 帖');

    // 同一条用例里的正面对照：两段都有行的研究照常把两段都写出来（上一条不是「搜索永远不写」）。
    const both = snapshot({ revision: 2 });
    invoke.mockResolvedValue(both);
    useXResearchTaskStore.getState().upsert(both);
    mounted.rerender(props);
    const bothSummary = visibleText(mounted.find('x-research-summary'));
    expect(bothSummary).toContain('搜索 2/2 个 query');
    expect(bothSummary).toContain('采集 128 帖');

    // 两段都是 0 行（还没有工作的一项研究）：整行不画，而不是留一个空 div。
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 3, search: [], read: [],
      counts: { submissions: 1, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0,
        interrupted: 0, posts: 0, replies: 0, articles: 0, undelivered: 0,
        searchDone: 0, searchTotal: 0, readDone: 0, readTotal: 0 } }));
    mounted.rerender(props);
    expect(mounted.query('x-research-summary')).toBeNull();
  });

  it('says how many segments disagree, and stays quiet when only one does', async () => {
    // 同回合「取消 → 重试成功」时，卡头只挑最高优先级的词会把「最后交付了」藏进展开里。
    const cancelled = snapshot({ researchRunId: 'xrun-a', runId: 'turn-1', objective: '被取消的一段',
      createdAt: '2026-10-16T00:00:01.000Z', state: 'cancelled', stateReason: 'cancelled',
      cancelledBy: 'agent' });
    const completed = snapshot({ researchRunId: 'xrun-b', runId: 'turn-1', objective: '重试成功的一段',
      createdAt: '2026-10-16T00:00:02.000Z', state: 'completed',
      counts: { submissions: 1, queued: 0, running: 0, done: 1, failed: 0, cancelled: 0,
        interrupted: 0, posts: 4, replies: 0, articles: 0, undelivered: 0,
        searchDone: 1, searchTotal: 1, readDone: 0, readTotal: 0 } });
    const props = { threadId: 'thread-1', groupKey: 'turn-1', researchRunIds: ['xrun-a', 'xrun-b'] };
    useXResearchTaskStore.setState({ snapshotsByRunId: { 'xrun-a': cancelled, 'xrun-b': completed } });
    invoke.mockResolvedValue(completed);
    const mounted = mount(XResearchProgressCard, props);
    await mounted.settle();
    expect(visibleText(mounted.find('x-research-toggle'))).toContain('2 段：1 取消 / 1 完成');

    // 翻面：只有一段时不出现这句括注。同一条用例里换池子，证明上一条不是「永远都写」。
    useXResearchTaskStore.setState({ snapshotsByRunId: { 'xrun-b': completed } });
    mounted.rerender({ ...props, researchRunIds: ['xrun-b'] });
    await mounted.settle();
    expect(visibleText(mounted.find('x-research-toggle'))).not.toContain('段：');
  });
});
