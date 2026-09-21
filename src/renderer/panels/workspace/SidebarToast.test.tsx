import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '../../../test-support/miniReact';

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

const { SidebarToast, TOAST_MS } = await import('./SidebarToast');
const { useToastStore } = await import('../../stores/toastStore');

/** 8 秒后收起；指针停在上面不计时；点按钮 = 先收起再执行（spec §2.4）。 */
beforeEach(() => { vi.useFakeTimers(); useToastStore.setState({ toast: null }); });
afterEach(() => { vi.useRealTimers(); });

describe('SidebarToast', () => {
  it('到点收起：差 1ms 还在，满 8 秒没了', () => {
    useToastStore.getState().show({ message: '已归档 2 个对话' });
    const m = mount(SidebarToast, {});
    expect(m.find('sidebar-toast').props.children).toBeDefined();
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(useToastStore.getState().toast).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toast).toBeNull();
  });

  it('指针停在上面不计时；离开后重新计满 8 秒', () => {
    useToastStore.getState().show({ message: '已归档 2 个对话' });
    const m = mount(SidebarToast, {});
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
    const m = mount(SidebarToast, {});
    (m.find('sidebar-toast-action').props.onClick as () => void)();
    expect(run).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toast).toBeNull();

    useToastStore.getState().show({ message: '撤销失败' });
    const m2 = mount(SidebarToast, {});
    expect(m2.query('sidebar-toast')).not.toBeNull();
    expect(m2.query('sidebar-toast-action')).toBeNull();
  });
});
