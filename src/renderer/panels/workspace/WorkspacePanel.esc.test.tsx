import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '../../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});
const { directRead } = vi.hoisted(() => ({
  directRead<M extends Record<string, unknown>>(mod: M, key: keyof M & string): M {
    const real = mod[key] as unknown as { getState: () => unknown };
    const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as M[typeof key];
    Object.assign(hook as object, real);
    return { ...mod, [key]: hook };
  },
}));
vi.mock('../../stores/uiStore', async (orig) => directRead(await orig<typeof import('../../stores/uiStore')>(), 'useUiStore'));
vi.mock('./sidebarSelection', async (orig) => directRead(await orig<typeof import('./sidebarSelection')>(), 'useSidebarSelection'));

const { WorkspacePanel } = await import('./WorkspacePanel');
const { SidebarToast } = await import('./SidebarToast');
const { useSidebarSelection } = await import('./sidebarSelection');
const { findOneWhere } = await import('../../../test-support/miniReact');

/**
 * 多选态才挂 Esc；菜单已经 preventDefault 过的那一下不清（spec §4.4）。
 * window 上的监听用一个记账的假 window 捕获，按注册顺序派发。
 */
type L = (e: { key: string; defaultPrevented: boolean }) => void;
let listeners: Array<{ type: string; fn: L }> = [];
const press = (key: string, defaultPrevented = false) => {
  for (const l of listeners.filter((x) => x.type === 'keydown')) l.fn({ key, defaultPrevented });
};

beforeEach(() => {
  listeners = [];
  (globalThis as unknown as Record<string, unknown>).window = {
    addEventListener: (type: string, fn: L) => { listeners.push({ type, fn }); },
    removeEventListener: (type: string, fn: L) => { listeners = listeners.filter((x) => !(x.type === type && x.fn === fn)); },
  };
});
afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).window; });

describe('WorkspacePanel：Esc 清多选', () => {
  it('没有多选时不挂监听；多选态下 Esc 清空；已被 preventDefault 的 Esc 不清', () => {
    useSidebarSelection.setState({ selectedIds: [], anchorId: null });
    const m = mount(WorkspacePanel, {});
    expect(listeners.filter((x) => x.type === 'keydown')).toHaveLength(0);

    useSidebarSelection.setState({ selectedIds: ['a', 'b'], anchorId: 'a' });
    m.rerender({});
    expect(listeners.filter((x) => x.type === 'keydown')).toHaveLength(1);
    press('Escape', true);
    expect(useSidebarSelection.getState().selectedIds).toEqual(['a', 'b']);
    press('Enter');
    expect(useSidebarSelection.getState().selectedIds).toEqual(['a', 'b']);
    press('Escape');
    expect(useSidebarSelection.getState().selectedIds).toEqual([]);
  });

  it('挂着撤销提示', () => {
    const m = mount(WorkspacePanel, {});
    expect(findOneWhere(m.tree, (el) => el.type === SidebarToast)).toBeDefined();
  });
});
