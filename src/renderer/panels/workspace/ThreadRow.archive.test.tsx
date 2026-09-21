import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, findOneWhere, type MiniElement } from '../../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// zustand 的 hook 走真 React 的 useSyncExternalStore，在 miniReact 下只能换成直读（同 renameWindowBlur.test.tsx）。
// vi.mock 会被提到文件最顶上，工厂里要用的 helper 得经 vi.hoisted 一起提上去。
const { directRead } = vi.hoisted(() => ({
  directRead<M extends Record<string, unknown>>(mod: M, key: keyof M & string): M {
    const real = mod[key] as unknown as { getState: () => unknown };
    const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as M[typeof key];
    Object.assign(hook as object, real);
    return { ...mod, [key]: hook };
  },
}));
vi.mock('../../stores/threadsStore', async (orig) => directRead(await orig<typeof import('../../stores/threadsStore')>(), 'useThreadsStore'));
vi.mock('../../stores/uiStore', async (orig) => directRead(await orig<typeof import('../../stores/uiStore')>(), 'useUiStore'));
vi.mock('../../stores/runsStore', async (orig) => directRead(await orig<typeof import('../../stores/runsStore')>(), 'useRunsStore'));
vi.mock('./threadActions', async (orig) => ({
  ...(await orig<typeof import('./threadActions')>()),
  archiveThreads: vi.fn(async () => {}),
  deleteThreads: vi.fn(async () => true),
}));

const { ThreadRow } = await import('./ThreadRow');
const { ThreadStatusBadge } = await import('./ThreadStatusBadge');
const { ContextMenu } = await import('../../shared/ContextMenu');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useRunsStore } = await import('../../stores/runsStore');
const { useSidebarSelection } = await import('./sidebarSelection');
const { archiveThreads, deleteThreads } = await import('./threadActions');

/**
 * ThreadRow 的接线（spec 2026-09-21-thread-archive-design §2.1–§2.3、§4.1）。miniReact 不调子组件：
 * ContextMenu / DropdownMenu 只是树上的节点，它们的 children（菜单项）照样在树里、能按 testId 找到。
 */
const P = '/tmp/proj-arc';
const T = (id: string) => ({ id, projectPath: P, title: `标题-${id}`, createdAt: '2026-09-01T00:00:00Z', lastActiveAt: '2026-09-01T00:00:00Z' });
const A = T('a'), B = T('b'), C = T('c');
const ORDER = ['a', 'b', 'c'];
const ev = (extra: Record<string, unknown> = {}) => ({
  preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 40, clientY: 60,
  shiftKey: false, metaKey: false, ctrlKey: false, ...extra,
});
const ctxMenu = (tree: unknown): MiniElement => findOneWhere(tree, (el) => el.type === ContextMenu);

beforeEach(() => {
  useThreadsStore.setState({
    ...useThreadsStore.getInitialState(),
    projects: [{ path: P, addedAt: '2026-09-01T00:00:00Z' }],
    threadsByProject: { [P]: [A, B, C] },
    currentThreadId: 'a',
  });
  useRunsStore.setState({ runStateByThread: {} });
  useSidebarSelection.setState({ selectedIds: [], anchorId: null });
  vi.mocked(archiveThreads).mockClear();
  vi.mocked(deleteThreads).mockClear();
  (globalThis as unknown as Record<string, unknown>).window = { kydog: { platform: 'darwin', invoke: vi.fn() } };
});
afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).window; });

describe('ThreadRow：单行', () => {
  it('悬停区是归档键，没有 ×；「…」菜单里是 重命名 / 归档 / 删除…', () => {
    const m = mount(ThreadRow, { thread: A, selection: [], order: ORDER });
    expect(m.find('archive-thread-a')).toBeDefined();
    expect(m.query('delete-thread-a')).toBeNull();
    expect(m.find('thread-rename-a').props.label).toBe('重命名');
    expect(m.find('thread-archive-a').props.label).toBe('归档');
    expect(m.find('thread-delete-a').props).toMatchObject({ label: '删除…', destructive: true });
  });

  it('点归档键 → archiveThreads([这一个])；点「删除…」→ deleteThreads([这一个])', () => {
    const m = mount(ThreadRow, { thread: A, selection: [], order: ORDER });
    (m.find('archive-thread-a').props.onClick as (e: unknown) => void)(ev());
    expect(vi.mocked(archiveThreads).mock.calls).toEqual([[[A]]]);
    (m.find('thread-delete-a').props.onClick as () => void)();
    expect(vi.mocked(deleteThreads).mock.calls).toEqual([[[A]]]);
  });

  it('运行中：归档键禁用、「…」与右键里的归档项禁用并写「运行中」；不运行时同一个键可用', () => {
    useRunsStore.setState({ runStateByThread: { a: { status: 'running', runId: 'r1' } } });
    const m = mount(ThreadRow, { thread: A, selection: [], order: ORDER });
    expect(m.find('archive-thread-a').props.disabled).toBe(true);
    expect(m.find('thread-archive-a').props).toMatchObject({ disabled: true, hint: '运行中' });
    (m.tree as MiniElement).props.onContextMenu(ev());
    expect(m.find('thread-ctx-archive-a').props).toMatchObject({ disabled: true, hint: '运行中' });

    useRunsStore.setState({ runStateByThread: {} });
    const m2 = mount(ThreadRow, { thread: A, selection: [], order: ORDER });
    expect(m2.find('archive-thread-a').props.disabled).toBe(false);
  });
});

describe('ThreadRow：点选', () => {
  it('⇧ 单击 → 进选择 store、不打开；mousedown 带 ⇧ 时 preventDefault', () => {
    const m = mount(ThreadRow, { thread: C, selection: [], order: ORDER });
    const down = ev({ shiftKey: true });
    (m.tree as MiniElement).props.onMouseDown(down);
    expect(down.preventDefault).toHaveBeenCalled();
    (m.tree as MiniElement).props.onClick(ev({ shiftKey: true }));
    expect(useSidebarSelection.getState().selectedIds).toEqual(['a', 'b', 'c']);
    expect(useThreadsStore.getState().currentThreadId).toBe('a');
  });

  it('macOS 上 ⌘ 是切换键、Ctrl 不是；Windows 上反过来', () => {
    const m = mount(ThreadRow, { thread: B, selection: [], order: ORDER });
    (m.tree as MiniElement).props.onClick(ev({ metaKey: true }));
    expect(useSidebarSelection.getState().selectedIds).toEqual(['a', 'b']);

    useSidebarSelection.setState({ selectedIds: [], anchorId: null });
    (globalThis as unknown as { window: { kydog: { platform: string } } }).window.kydog.platform = 'win32';
    (m.tree as MiniElement).props.onClick(ev({ metaKey: true }));
    // Windows 上 meta 不是切换键：当普通单击处理 → 打开 b、清空选中
    expect(useThreadsStore.getState().currentThreadId).toBe('b');
    expect(useSidebarSelection.getState().selectedIds).toEqual([]);
    // Ctrl 才是：在 c 上 Ctrl 单击 → 先放进当前对话 b，再加上 c
    const mc = mount(ThreadRow, { thread: C, selection: [], order: ORDER });
    (mc.tree as MiniElement).props.onClick(ev({ ctrlKey: true }));
    expect(useSidebarSelection.getState().selectedIds).toEqual(['b', 'c']);
    expect(useThreadsStore.getState().currentThreadId).toBe('b');
  });

  it('普通单击 → 打开、清空选中', () => {
    useSidebarSelection.setState({ selectedIds: ['a', 'b'], anchorId: 'a' });
    const m = mount(ThreadRow, { thread: C, selection: ['a', 'b'], order: ORDER });
    (m.tree as MiniElement).props.onClick(ev());
    expect(useThreadsStore.getState().currentThreadId).toBe('c');
    expect(useSidebarSelection.getState().selectedIds).toEqual([]);
  });
});

describe('ThreadRow：右键', () => {
  it('右键没被选中的行 → 单行菜单、清空多选、不打开', () => {
    // currentThreadId 故意设成不是 A：原先夹具里当前对话恰好就是 A，「不打开」这条断言
    // 就算右键把 A 打开了也照样读到 'a'，抓不住回归（ContextMenu 面板上的点击冒泡到行上）。
    useThreadsStore.setState({ currentThreadId: 'b' });
    useSidebarSelection.setState({ selectedIds: ['b', 'c'], anchorId: 'b' });
    const m = mount(ThreadRow, { thread: A, selection: ['b', 'c'], order: ORDER });
    const e = ev();
    (m.tree as MiniElement).props.onContextMenu(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(ctxMenu(m.tree).props.at).toEqual({ x: 40, y: 60 });
    expect(m.find('thread-ctx-archive-a')).toBeDefined();
    expect(m.query('thread-ctx-batch-archive')).toBeNull();
    expect(useSidebarSelection.getState().selectedIds).toEqual([]);
    expect(useThreadsStore.getState().currentThreadId).toBe('b');

    // 正向：同一批选中里，被选中的行右键弹的才是批量菜单——证明上面的 null 不是查找本身坏了。
    useSidebarSelection.setState({ selectedIds: ['b', 'c'], anchorId: 'b' });
    const mb = mount(ThreadRow, { thread: B, selection: ['b', 'c'], order: ORDER });
    (mb.tree as MiniElement).props.onContextMenu(ev());
    expect(mb.find('thread-ctx-batch-archive')).toBeDefined();
  });

  it('多选态右键被选中的行 → 批量菜单写数量；点归档 → archiveThreads(那两个)、清空多选', () => {
    // store 里的多选（selectedIds）故意比 selection prop 多一个 'a'：批量操作走的是
    // ThreadRow 收到的 selection prop（可见顺序、按 order 算），不是直接掏 store 的全集——
    // 后者会把收起的 project 底下那些也算进去。两个集合撞成一样的话，一个直接读 store
    // 的实现也会让下面「归档 2 个 / [B, C]」这些断言照样绿，抓不住这个回归。
    useSidebarSelection.setState({ selectedIds: ['a', 'b', 'c'], anchorId: 'b' });
    const m = mount(ThreadRow, { thread: B, selection: ['b', 'c'], order: ORDER });
    (m.tree as MiniElement).props.onContextMenu(ev());
    expect(m.query('thread-ctx-archive-b')).toBeNull();
    // 正向：同一行没在多选里时，右键出的是单行项——证明上面的 null 不是查找本身坏了。
    const ma = mount(ThreadRow, { thread: A, selection: [], order: ORDER });
    (ma.tree as MiniElement).props.onContextMenu(ev());
    expect(ma.find('thread-ctx-archive-a')).toBeDefined();
    // ma 右键的是没被选中的 A：会清空多选。批量测试要接着走，把选中集合复原。
    useSidebarSelection.setState({ selectedIds: ['a', 'b', 'c'], anchorId: 'b' });

    const item = m.find('thread-ctx-batch-archive');
    expect(item.props.label).toBe('归档 2 个对话');
    expect(m.find('thread-ctx-batch-delete').props.label).toBe('删除 2 个对话…');
    (item.props.onClick as () => void)();
    expect(vi.mocked(archiveThreads).mock.calls).toEqual([[[B, C]]]);
    expect(useSidebarSelection.getState().selectedIds).toEqual([]);
  });

  it('批量里有运行中的 → 批量归档禁用、写「其中 1 个正在运行」；删除仍可用', () => {
    useRunsStore.setState({ runStateByThread: { c: { status: 'running', runId: 'r1' } } });
    const m = mount(ThreadRow, { thread: B, selection: ['b', 'c'], order: ORDER });
    (m.tree as MiniElement).props.onContextMenu(ev());
    expect(m.find('thread-ctx-batch-archive').props).toMatchObject({ disabled: true, hint: '其中 1 个正在运行' });
    expect(m.find('thread-ctx-batch-delete').props.disabled).toBeUndefined();
  });

  it('多选态：被选中的行底色 accent-soft、状态位是勾、悬停不出按钮也不出图钉键', () => {
    const m = mount(ThreadRow, { thread: B, selection: ['b', 'c'], order: ORDER });
    (m.tree as MiniElement).props.onMouseEnter();
    const row = m.tree as MiniElement;
    expect(row.props['data-selected']).toBe('true');
    expect(row.props.style.background).toBe('var(--color-accent-soft)');
    const badge = findOneWhere(m.tree, (el) => el.type === ThreadStatusBadge);
    expect(badge.props).toMatchObject({ selected: true, hovered: false });
    expect(m.find('thread-row-actions').props.style.pointerEvents).toBe('none');
    // 正向：同一行不在多选态时，悬停就出按钮
    const m2 = mount(ThreadRow, { thread: B, selection: [], order: ORDER });
    (m2.tree as MiniElement).props.onMouseEnter();
    expect(m2.find('thread-row-actions').props.style.pointerEvents).toBe('auto');
    expect(findOneWhere(m2.tree, (el) => el.type === ThreadStatusBadge).props).toMatchObject({ selected: false, hovered: true });
  });
});
