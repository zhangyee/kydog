import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '../../../test-support/miniReact';
import type { MiniElement } from '../../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// 只把 React 订阅那一层换成直读，getState / setState 用真身（同 renameWindowBlur.test.tsx）。
vi.mock('../../stores/toastStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/toastStore')>();
  const real = mod.useToastStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useToastStore: hook };
});

const { SidebarToast, SidebarToastBody, TOAST_MS } = await import('./SidebarToast');
const { useToastStore } = await import('../../stores/toastStore');

/** 8 秒后收起；指针停在上面不计时；点按钮 = 先收起再执行（spec §2.4）。
 *  行为都挂在 SidebarToastBody（miniReact 不展开子组件，SidebarToast 本身没有 hook 可测）。 */
beforeEach(() => { vi.useFakeTimers(); useToastStore.setState({ toast: null }); });
afterEach(() => { vi.useRealTimers(); });

describe('SidebarToast（外层）', () => {
  it('没有 toast 时不渲染任何东西', () => {
    const m = mount(SidebarToast, {});
    expect(m.tree).toBeNull();
  });

  it('有 toast 时把它转给 SidebarToastBody，key 是 toast.id', () => {
    useToastStore.getState().show({ message: '已归档 2 个对话' });
    const toast = useToastStore.getState().toast!;
    const m = mount(SidebarToast, {});
    const node = m.tree as MiniElement;
    expect(node.type).toBe(SidebarToastBody);
    expect(node.key).toBe(String(toast.id));
    expect(node.props.toast).toBe(toast);
  });
});

describe('SidebarToastBody', () => {
  it('到点收起：差 1ms 还在，满 8 秒没了', () => {
    useToastStore.getState().show({ message: '已归档 2 个对话' });
    const toast = useToastStore.getState().toast!;
    const m = mount(SidebarToastBody, { toast });
    expect(m.find('sidebar-toast').props.children).toBeDefined();
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(useToastStore.getState().toast).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toast).toBeNull();
  });

  it('指针停在上面不计时；离开后重新计满 8 秒', () => {
    useToastStore.getState().show({ message: '已归档 2 个对话' });
    const toast = useToastStore.getState().toast!;
    const m = mount(SidebarToastBody, { toast });
    (m.find('sidebar-toast').props.onMouseEnter as () => void)();
    vi.advanceTimersByTime(TOAST_MS * 3);
    expect(useToastStore.getState().toast).not.toBeNull();
    (m.find('sidebar-toast').props.onMouseLeave as () => void)();
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(useToastStore.getState().toast).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toast).toBeNull();
  });

  it('点「撤销」：收起并执行；没有 action 时不出按钮', () => {
    const run = vi.fn();
    useToastStore.getState().show({ message: '已归档「x」', action: { label: '撤销', run } });
    const toast = useToastStore.getState().toast!;
    const m = mount(SidebarToastBody, { toast });
    (m.find('sidebar-toast-action').props.onClick as () => void)();
    expect(run).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toast).toBeNull();

    useToastStore.getState().show({ message: '撤销失败' });
    const toast2 = useToastStore.getState().toast!;
    const m2 = mount(SidebarToastBody, { toast: toast2 });
    expect(m2.query('sidebar-toast')).not.toBeNull();
    expect(m2.query('sidebar-toast-action')).toBeNull();
  });

  /**
   * 回归（评审终审发现）：hover 状态曾经放在 SidebarToast 自己身上，而那个组件没有 toast
   * 时只是 `return null`，从不真正卸载——点「撤销」那一下，指针正停在提示上（hovered
   * 为 true），提示被摘掉却等不到 mouseleave，hovered 卡死在 true。下一条提示复用同一个
   * 组件实例时，旧的 hovered 直接带过去，它的计时器永远不会起（真 Chromium 里验证过）。
   *
   * 现在 hovered 挂在 SidebarToastBody，靠 `key={toast.id}` 保证换一条 toast 就是全新实例
   * ——这里直接模拟「旧实例卸载、新实例挂载」（对应 key 变化时 React 真实会做的事）来证明
   * 新提示不会继承上一条的 hovered。
   */
  it('撤销点掉一条之后，下一条不会继承上一条的 hovered——照样能到点自动收起', () => {
    const run = vi.fn();
    useToastStore.getState().show({ message: '已归档「x」', action: { label: '撤销', run } });
    const toast1 = useToastStore.getState().toast!;
    const m1 = mount(SidebarToastBody, { toast: toast1 });

    (m1.find('sidebar-toast').props.onMouseEnter as () => void)();
    // 正向对照：悬停确实暂停了这一条自己的计时器——不是凑巧多久都不会到点。
    vi.advanceTimersByTime(TOAST_MS * 3);
    expect(useToastStore.getState().toast).not.toBeNull();

    (m1.find('sidebar-toast-action').props.onClick as () => void)();
    expect(run).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toast).toBeNull();
    m1.unmount(); // 对应真实 DOM 里 key 变化触发的卸载

    useToastStore.getState().show({ message: '下一条' });
    const toast2 = useToastStore.getState().toast!;
    mount(SidebarToastBody, { toast: toast2 }); // 对应 key 变化触发的全新挂载

    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(useToastStore.getState().toast).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toast).toBeNull();
  });
});
