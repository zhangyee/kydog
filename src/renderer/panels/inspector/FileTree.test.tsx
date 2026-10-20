import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, findAllByProp, findAllWhere, queryByTestId } from '../../../test-support/miniReact';

/**
 * **文件树读目录失败时要说出来**。以前 FileTree 与 Row 调 `project.readDir` 只有 `.then`：
 * 读失败是一条 unhandled rejection，界面永远停在「加载中…」—— 用户报「新会话一直加载中」
 * 那次，检视栏的文件树也停在这里，从截图上分不出是还在读、还是已经失败了。
 *
 * miniReact 只渲染最外层组件，`FileTreeError` 是它树里的一个元素，按 props 找。store 变了
 * miniReact 不会自己重渲染（useUiStore 换成了直读），所以每次落地后手动 rerender。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

vi.mock('../../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

vi.mock('../../stores/threadsStore', async (original) => {
  const mod = await original<typeof import('../../stores/threadsStore')>();
  const real = mod.useThreadsStore;
  const hook = ((sel: (s: unknown) => unknown) => sel(real.getState())) as unknown as typeof real;
  Object.assign(hook, real); return { ...mod, useThreadsStore: hook };
});
vi.mock('../../stores/harnessStore', async (original) => {
  const mod = await original<typeof import('../../stores/harnessStore')>();
  const real = mod.useHarnessStore;
  const hook = ((sel: (s: unknown) => unknown) => sel(real.getState())) as unknown as typeof real;
  Object.assign(hook, real); return { ...mod, useHarnessStore: hook };
});
const { FileTree } = await import('./FileTree');
const { useUiStore } = await import('../../stores/uiStore');
const { FileTreeRow } = await import('./FileTreeRow');
const { FileTreeToolbar } = await import('./FileTreeToolbar');
const { useConfirmStore } = await import('../../stores/confirmStore');

const ROOT = 'C:\\Users\\u\\Desktop\\article';
/** 下一次 readDir 的结局：一个 Error 就拒，否则就给这份列表。 */
let next: Error | Array<{ name: string; path: string; kind: 'file' | 'dir'; mtimeMs: number | null }> = [];
let reads = 0;

beforeEach(() => {
  reads = 0;
  useUiStore.setState(useUiStore.getInitialState());
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string) => {
        if (method !== 'project.readDir') return Promise.resolve(undefined);
        reads += 1;
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
});

type Props = { projectPath: string };
const errorOf = (tree: unknown) => findAllByProp(tree, 'testId', 'file-tree-error');

describe('FileTree：根目录读失败', () => {
  it('显示错误原文与重试，不停在「加载中」；重试成功后出列表', async () => {
    next = [{ name: 'control.md', path: `${ROOT}\\control.md`, kind: 'file', mtimeMs: 2 }];
    const control = mount(FileTree, { projectPath: ROOT }); await control.settle(); control.rerender({ projectPath: ROOT });
    expect(queryByTestId(control.tree, 'file-tree')).not.toBeNull(); control.unmount();
    useUiStore.setState(useUiStore.getInitialState()); reads = 0;
    next = new Error(`cannot read ${ROOT} (EPERM)`);
    const m = mount(FileTree, { projectPath: ROOT } as Props);
    await m.settle();
    m.rerender({ projectPath: ROOT });

    const [err] = errorOf(m.tree);
    expect(err.props.message).toBe(`cannot read ${ROOT} (EPERM)`);
    expect(queryByTestId(m.tree, 'file-tree')).toBeNull();
    // 失败后不自动重试：重渲染几次都只读过那一次。
    m.rerender({ projectPath: ROOT });
    await m.settle();
    expect(reads).toBe(1);

    next = [{ name: 'draft.md', path: `${ROOT}\\draft.md`, kind: 'file', mtimeMs: null }];
    (err.props.onRetry as () => void)();
    m.rerender({ projectPath: ROOT });
    await m.settle();
    m.rerender({ projectPath: ROOT });
    expect(reads).toBe(2);
    expect(errorOf(m.tree)).toHaveLength(0);
    expect(queryByTestId(m.tree, 'file-tree')).not.toBeNull();
  });
});

const node = (path: string, mtimeMs: number, kind: 'file' | 'dir' = 'file') => ({ path, name: path.split('/').pop()!, mtimeMs, kind });
const click = (shiftKey = false, ctrlKey = false, metaKey = false) => ({ shiftKey, ctrlKey, metaKey });
const rows = (tree: unknown) => findAllWhere(tree, el => el.type === FileTreeRow);
const toolbar = (tree: unknown) => findAllWhere(tree, el => el.type === FileTreeToolbar)[0];
it('sorted visible rows select by path; collapse prunes children permanently; outside context deletes only that path', async () => {
  const requests: unknown[] = [];
  Object.assign(window.kydog, { invoke: async (method: string, args: unknown) => {
    if (method === 'project.readDir') return [];
    requests.push(args); return { trashed: ['/p/a.md'], failed: [] };
  } });
  useUiStore.getState().setDir('/p', [node('/p/a.md', 10), node('/p/z.pdf', 90), node('/p/sub', 1, 'dir'), node('/p/c.html', 50)]);
  useUiStore.getState().setDir('/p/sub', [node('/p/sub/b.md', 60)]); useUiStore.getState().toggleDir('/p/sub');
  const m = mount(FileTree, { projectPath: '/p' });
  rows(m.tree).find(r => r.props.node.path === '/p/a.md')!.props.onSelect(click());
  rows(m.tree).find(r => r.props.node.path === '/p/z.pdf')!.props.onSelect(click(false, false, true));
  expect(toolbar(m.tree).props.selectedCount).toBe(2);
  toolbar(m.tree).props.onSort('modified'); m.rerender({ projectPath: '/p' });
  rows(m.tree).find(r => r.props.node.path === '/p/sub/b.md')!.props.onSelect(click(true));
  expect(rows(m.tree).filter(r => r.props.selected).map(r => r.props.node.path)).toEqual(['/p/sub/b.md', '/p/z.pdf']);
  rows(m.tree).find(r => r.props.node.path === '/p/z.pdf')!.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 2, clientY: 3 });
  expect(toolbar(m.tree).props.selectedCount).toBe(2);
  useUiStore.getState().toggleDir('/p/sub'); m.rerender({ projectPath: '/p' });
  expect(toolbar(m.tree).props.selectedCount).toBe(1);
  useUiStore.getState().toggleDir('/p/sub'); m.rerender({ projectPath: '/p' });
  expect(rows(m.tree).filter(r => r.props.selected).map(r => r.props.node.path)).toEqual(['/p/z.pdf']);
  rows(m.tree).find(r => r.props.node.path === '/p/a.md')!.props.onContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 2, clientY: 3 });
  expect(rows(m.tree).filter(r => r.props.selected).map(r => r.props.node.path)).toEqual(['/p/a.md']);
  toolbar(m.tree).props.onDelete(); useConfirmStore.getState().resolve(true); await m.settle();
  expect(requests).toEqual([{ projectPath: '/p', paths: ['/p/a.md'] }]);
});
it('locks before confirmation, keeps failed path and error, and catches request errors', async () => {
  useUiStore.getState().setDir('/p', [node('/p/a.md', 50), node('/p/b.pdf', 1)]);
  let requests = 0, reject = false;
  let complete!: () => void;
  Object.assign(window.kydog, { invoke: async (method: string) => {
    if (method === 'project.readDir') return [node('/p/b.pdf', 1)];
    requests++; if (reject) throw new Error('request denied');
    await new Promise<void>(resolve => { complete = resolve; });
    return { trashed: ['/p/a.md'], failed: [{ path: '/p/b.pdf', error: { code: 'fs.access_denied', message: 'EPERM b' } }] };
  } });
  const m = mount(FileTree, { projectPath: '/p' });
  rows(m.tree)[0].props.onSelect(click()); rows(m.tree)[1].props.onSelect(click(false, true));
  const remove = toolbar(m.tree).props.onDelete; remove(); const confirm = useConfirmStore.getState().request; remove();
  expect(useConfirmStore.getState().request).toBe(confirm); expect(toolbar(m.tree).props.pending).toBe(true);
  useConfirmStore.getState().resolve(true); await m.settle(); remove();
  expect(requests).toBe(1); expect(useConfirmStore.getState().request).toBeNull();
  complete(); await m.settle(); m.rerender({ projectPath: '/p' });
  expect(requests).toBe(1); expect(toolbar(m.tree).props.selectedCount).toBe(1);
  expect(findAllWhere(m.tree, el => el.props.text?.includes('b.pdf') && el.props.text?.includes('EPERM b'))).toHaveLength(1);
  reject = true; toolbar(m.tree).props.onDelete(); useConfirmStore.getState().resolve(true); await m.settle();
  expect(findAllWhere(m.tree, el => el.props.text?.includes('request denied'))).toHaveLength(1);
});
it('old project response closes deleted tabs but cannot publish selection or errors in new project', async () => {
  useUiStore.getState().setDir('/p', [node('/p/a.md', 2)]); useUiStore.getState().setDir('/q', [node('/q/z.pdf', 1)]);
  useUiStore.getState().openFile('/p/a.md'); let complete!: (r: unknown) => void;
  let oldError = true;
  Object.assign(window.kydog, { invoke: (method: string) => method === 'file.trash' ? oldError ? Promise.reject(new Error('old error')) : new Promise(r => { complete = r; }) : Promise.resolve([]) });
  const m = mount(FileTree, { projectPath: '/p' }); rows(m.tree)[0].props.onSelect(click());
  toolbar(m.tree).props.onDelete(); useConfirmStore.getState().resolve(true); await m.settle();
  expect(findAllWhere(m.tree, el => el.props.text?.includes('old error'))).toHaveLength(1); oldError = false;
  toolbar(m.tree).props.onSort('modified'); toolbar(m.tree).props.onDelete(); useConfirmStore.getState().resolve(true); await m.settle();
  expect(useUiStore.getState().openFileTabs.map(t => t.path)).toEqual(['/p/a.md']);
  m.unmount(); const q = mount(FileTree, { projectPath: '/q' }); expect(toolbar(q.tree).props.selectedCount).toBe(0);
  rows(q.tree)[0].props.onSelect(click());
  complete({ trashed: ['/p/a.md'], failed: [{ path: '/p/a.md', error: { code: 'fs.access_denied', message: 'old error' } }] }); await q.settle();
  expect(useUiStore.getState().openFileTabs).toEqual([]); expect(toolbar(q.tree).props.selectedCount).toBe(1);
  expect(toolbar(q.tree).props.sortBy).toBe('modified');
  expect(findAllWhere(m.tree, el => el.props.text?.includes('old error'))).toHaveLength(0);
  expect(findAllWhere(q.tree, el => el.props.text?.includes('old error'))).toHaveLength(0);
});
it('Delete and Esc are root-local, ignore input/defaultPrevented, blank click clears only selection', async () => {
  useUiStore.getState().setDir('/p', [node('/p/a.md', 5)]);
  const m = mount(FileTree, { projectPath: '/p' }); rows(m.tree)[0].props.onSelect(click());
  const key = (tagName = 'DIV', defaultPrevented = false, key = 'Delete') => ({ key, target: { tagName, isContentEditable: false }, defaultPrevented, preventDefault: vi.fn() });
  m.find('file-tree').props.onKeyDown(key()); expect(useConfirmStore.getState().request).not.toBeNull(); useConfirmStore.getState().resolve(false); await m.settle();
  expect(toolbar(m.tree).props.selectedCount).toBe(1);
  m.find('file-tree').props.onKeyDown(key('INPUT')); expect(useConfirmStore.getState().request).toBeNull();
  m.find('file-tree').props.onKeyDown(key('DIV', true)); expect(useConfirmStore.getState().request).toBeNull();
  m.find('file-tree').props.onKeyDown(key('DIV', false, 'Escape')); expect(toolbar(m.tree).props.selectedCount).toBe(0);
  rows(m.tree)[0].props.onSelect(click()); expect(toolbar(m.tree).props.selectedCount).toBe(1);
  m.find('file-tree').props.onClick(); expect(toolbar(m.tree).props.selectedCount).toBe(0);
});

it('Inspector project rerender provides a new FileTree key while retaining window sort', async () => {
  const { InspectorPanel } = await import('./InspectorPanel');
  const { useThreadsStore } = await import('../../stores/threadsStore');
  const thread = (id: string, projectPath: string) => ({ id, projectPath, title: id, createdAt: '2026-01-01', lastActiveAt: '2026-01-02' });
  useThreadsStore.getState().hydrate([], [thread('p', '/p'), thread('q', '/q')]);
  useThreadsStore.getState().selectThread('p'); useUiStore.getState().setFileTreeSortBy('modified');
  const m = mount(InspectorPanel, {});
  expect(findAllWhere(m.tree, el => el.type === FileTree)[0].key).toBe('/p');
  useThreadsStore.getState().selectThread('q'); m.rerender({});
  expect(findAllWhere(m.tree, el => el.type === FileTree)[0].key).toBe('/q');
  expect(useUiStore.getState().fileTreeSortBy).toBe('modified');
});
