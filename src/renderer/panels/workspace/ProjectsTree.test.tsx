import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, findAllWhere, type Mounted } from '../../../test-support/miniReact';
import { ProjectsTree } from './ProjectsTree';
import { ThreadRow } from './ThreadRow';
import { ProjectRow } from './ProjectRow';
import { useUiStore } from '../../stores/uiStore';
import { useThreadsStore } from '../../stores/threadsStore';
import { useSidebarSelection } from './sidebarSelection';
import type { Thread } from '../../../shared/types';

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  ...(await import('../../../test-support/miniReact')).reactHooks,
}));
vi.mock('../../stores/uiStore', async (original) => {
  const mod = await original<typeof import('../../stores/uiStore')>();
  const real = mod.useUiStore;
  return { ...mod, useUiStore: Object.assign((sel: (s: ReturnType<typeof real.getState>) => unknown) => sel(real.getState()), real) };
});
vi.mock('../../stores/threadsStore', async (original) => {
  const mod = await original<typeof import('../../stores/threadsStore')>();
  const real = mod.useThreadsStore;
  return { ...mod, useThreadsStore: Object.assign((sel: (s: ReturnType<typeof real.getState>) => unknown) => sel(real.getState()), real) };
});
vi.mock('./sidebarSelection', async (original) => {
  const mod = await original<typeof import('./sidebarSelection')>();
  const real = mod.useSidebarSelection;
  return { ...mod, useSidebarSelection: Object.assign((sel: (s: ReturnType<typeof real.getState>) => unknown) => sel(real.getState()), real) };
});

const projects = [{ path: '/a', addedAt: '1' }, { path: '/b', addedAt: '2' }];
// Separate from the pinned sorting fixture: t7 must really be hidden.
const threads = (count = 7): Thread[] => Array.from({ length: count }, (_, i) => ({
  id: `t${i + 1}`, projectPath: '/a', title: `t${i + 1}`,
  createdAt: `2026-01-0${i + 1}`, lastActiveAt: `2026-02-0${8 - i}`,
}));
const b: Thread = { id: 'b', projectPath: '/b', title: 'b', createdAt: '0', lastActiveAt: '0' };
const firstFive = ['t1', 't2', 't3', 't4', 't5'];
const allSeven = [...firstFive, 't6', 't7'];
let tree: Mounted<unknown>;
const rerender = () => { tree.rerender({}); tree.rerender({}); };
const rows = () => findAllWhere(tree.tree, el => el.type === ThreadRow);
const ids = () => rows().map(el => el.props.thread.id);
const toggle = (path = '/a') => findAllWhere(tree.tree, el => el.type === ProjectRow && el.props.project.path === path)[0].props.onToggleExpand();
const more = (path = '/a') => tree.find(`project-show-more-${path}`).props.onClick();

beforeEach(() => {
  tree?.unmount();
  useUiStore.setState(useUiStore.getInitialState(), true);
  useThreadsStore.setState(useThreadsStore.getInitialState(), true);
  useSidebarSelection.setState({ selectedIds: [], anchorId: null });
  useThreadsStore.getState().hydrate(projects, [...threads(), b]);
});

describe('ProjectsTree preview wiring', () => {
  it.each([
    ['updated', ['t7', 't1', 't2', 't3', 't4']],
    ['created', ['t7', 't6', 't5', 't4', 't3']],
  ] as const)('actual %s rows honor pinning before preview and share their order', (sort, want) => {
    const all = threads();
    const shuffled = [3, 7, 1, 6, 2, 5, 4].map(i => ({ ...all[i - 1], pinned: i === 7 }));
    useThreadsStore.getState().hydrate(projects, [...shuffled, b]);
    useUiStore.getState().setProjectsSortBy(sort);
    tree = mount(ProjectsTree, {});
    expect(ids()).toEqual([...want, 'b']);
    rows().forEach(row => expect(row.props.order).toEqual([...want, 'b']));
  });

  it('expanding A leaves independent B at five; collapse-all resets both', () => {
    const dest = threads().map(t => ({ ...t, id: `b-${t.id}`, projectPath: '/b', lastActiveAt: `${t.lastActiveAt}T12:00:00Z` }));
    useThreadsStore.getState().hydrate(projects, [...threads(), ...dest]);
    tree = mount(ProjectsTree, {});
    more(); rerender();
    expect(ids()).toEqual([...allSeven, 'b-t1', 'b-t2', 'b-t3', 'b-t4', 'b-t5']);
    expect(tree.find('project-show-more-/b')).toBeDefined();
    more('/b'); rerender();
    expect(ids()).toHaveLength(14);
    useUiStore.getState().collapseAllProjects(['/a', '/b']); rerender();
    expect(ids()).toEqual([]);
    toggle(); toggle('/b'); rerender();
    expect(ids()).toEqual([...firstFive, 'b-t1', 'b-t2', 'b-t3', 'b-t4', 'b-t5']);
    expect(tree.find('project-show-more-/a')).toBeDefined();
    expect(tree.find('project-show-more-/b')).toBeDefined();
  });

  it('actual rows and range order use the same preview, with per-project show-more', () => {
    tree = mount(ProjectsTree, {});
    expect(ids()).toEqual([...firstFive, 'b']);
    expect(tree.find('project-show-more-/a').props.children).toBe('展开显示');
    rows().forEach(row => expect(row.props.order).toEqual([...firstFive, 'b']));
    more(); rerender();
    expect(ids()).toEqual([...allSeven, 'b']);
    expect(tree.query('project-show-more-/a')).toBeNull();
    rows().forEach(row => expect(row.props.order).toEqual([...allSeven, 'b']));
  });

  it('manual close/reopen resets hidden current and selection, same-ID navigation reveals again', () => {
    useThreadsStore.getState().selectThread('t7');
    tree = mount(ProjectsTree, {}); rerender();
    expect(ids()).toEqual([...allSeven, 'b']);
    useSidebarSelection.setState({ selectedIds: ['t4', 't5', 't6', 't7'], anchorId: 't4' }); rerender();
    rows().forEach(row => expect(row.props.selection).toEqual(['t4', 't5', 't6', 't7']));
    useSidebarSelection.getState().click({ id: 't7', shift: true, toggle: false }, { order: rows()[0].props.order, currentId: 't7' });
    expect(useSidebarSelection.getState().selectedIds).toEqual(['t4', 't5', 't6', 't7']);
    toggle(); rerender(); toggle(); rerender();
    expect(ids()).toEqual([...firstFive, 'b']);
    expect(tree.find('project-show-more-/a')).toBeDefined();
    expect(useThreadsStore.getState().currentThreadId).toBe('t7');
    rows().forEach(row => expect(row.props.selection).toEqual(['t4', 't5']));
    useSidebarSelection.getState().click({ id: 'b', shift: true, toggle: false }, { order: rows()[0].props.order, currentId: 't7' });
    expect(useSidebarSelection.getState().selectedIds).toEqual(['t4', 't5', 'b']);
    useThreadsStore.getState().selectThread('t7'); rerender();
    expect(ids()).toEqual([...allSeven, 'b']);
  });

  it('title/activity broadcasts cannot reopen manually collapsed project', () => {
    useThreadsStore.getState().selectThread('t7');
    tree = mount(ProjectsTree, {}); rerender();
    expect(ids()).toEqual([...allSeven, 'b']);
    toggle(); rerender();
    useThreadsStore.getState().upsertThread({ ...threads()[6], title: 'renamed', lastActiveAt: '9' }); rerender();
    expect(ids()).toEqual(['b']);
    toggle(); rerender();
    expect(ids()).toEqual(['t7', 't1', 't2', 't3', 't4', 'b']);
    expect(tree.find('project-show-more-/a')).toBeDefined();
  });

  it('consumes navigation only after target data and project arrive', () => {
    useThreadsStore.getState().hydrate([], []);
    useThreadsStore.getState().selectThread('t7');
    tree = mount(ProjectsTree, {});
    useThreadsStore.getState().upsertThread(threads()[6]); rerender();
    useUiStore.setState({ collapsedProjects: new Set(['/a']) });
    useThreadsStore.getState().hydrate(projects, [...threads(), b]); rerender();
    expect(ids()).toEqual([...allSeven, 'b']);
    expect([...useUiStore.getState().collapsedProjects]).toEqual([]);
  });

  it('a current thread migration expands its new project once; moving other threads does not', () => {
    const dest = threads().map(t => ({ ...t, id: `b-${t.id}`, projectPath: '/b', lastActiveAt: `${t.lastActiveAt}T12:00:00Z` }));
    useThreadsStore.getState().hydrate(projects, [...threads(), ...dest]);
    useThreadsStore.getState().selectThread('t7');
    tree = mount(ProjectsTree, {}); rerender();
    expect(ids()).toEqual([...allSeven, 'b-t1', 'b-t2', 'b-t3', 'b-t4', 'b-t5']);
    toggle('/b'); rerender();
    useThreadsStore.getState().upsertThread({ ...threads()[0], projectPath: '/b' }); rerender();
    expect(ids()).toEqual(['t2', 't3', 't4', 't5', 't6', 't7']);
    useThreadsStore.getState().upsertThread({ ...threads()[6], projectPath: '/b' }); rerender();
    expect(ids()).toEqual(['t2', 't3', 't4', 't5', 't6', 'b-t1', 't1', 'b-t2', 'b-t3', 'b-t4', 'b-t5', 'b-t6', 'b-t7', 't7']);
  });

  it('5→6 adds preview entry; show-all persists through growth, project/tab/group switches', () => {
    useThreadsStore.getState().hydrate(projects, [...threads(5), b]);
    tree = mount(ProjectsTree, {});
    expect(ids()).toEqual([...firstFive, 'b']);
    useThreadsStore.getState().upsertThread(threads(6)[5]); rerender();
    expect(ids()).toEqual([...firstFive, 'b']);
    expect(tree.find('project-show-more-/a')).toBeDefined();
    more(); rerender();
    expect(ids()).toEqual([...firstFive, 't6', 'b']);
    expect(tree.query('project-show-more-/a')).toBeNull();
    useThreadsStore.getState().upsertThread(threads()[6]);
    useThreadsStore.getState().selectThread('b');
    useUiStore.getState().openSettings(); useUiStore.getState().openFile('/b/x.md');
    useUiStore.getState().setProjectsGroupBy('time'); rerender();
    expect(ids()).toEqual([...allSeven, 'b']);
    useUiStore.getState().setProjectsGroupBy('project'); rerender();
    expect(ids()).toEqual([...allSeven, 'b']);
  });

  it.each([0, 5])('%i rows has no more entry after a positive entry control', count => {
    tree = mount(ProjectsTree, {});
    expect(tree.find('project-show-more-/a')).toBeDefined();
    useThreadsStore.getState().hydrate(projects, [...threads(count), b]); rerender();
    expect(ids()).toEqual(count === 0 ? ['b'] : [...firstFive, 'b']);
    expect(tree.query('project-show-more-/a')).toBeNull();
  });
});
