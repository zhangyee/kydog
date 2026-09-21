import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// createPortal 真身会把节点丢去 document.body，这里让它原样留在树里，好让单测按 testId 找到面板。
vi.mock('react-dom', async (orig) => ({
  ...(await orig<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node,
}));

const { ConfirmDialog } = await import('./ConfirmDialog');

type KeyListener = (e: { key: string; preventDefault: () => void }) => void;
type Registered = { event: string; fn: KeyListener; capture: boolean | undefined };

/**
 * 回归用例：Esc 监听必须挂在 window 的**捕获**阶段并 preventDefault（同 ContextMenu.tsx
 * 顶部注释的模式）——左栏多选的 Esc 监听在冒泡阶段、跳过 defaultPrevented 的事件；批量删除
 * 的确认框开着时，第一下 Esc 只该关掉确认框，不该连带清掉多选（点「取消」按钮不会清选中，
 * Esc 不能不一致）。挂在冒泡阶段的话，两个 window 监听器谁先跑只看注册先后，靠不住。
 */
describe('ConfirmDialog：Esc 走捕获阶段', () => {
  let listeners: Registered[];

  beforeEach(() => {
    listeners = [];
    (globalThis as unknown as Record<string, unknown>).document = { body: {} };
    (globalThis as unknown as Record<string, unknown>).window = {
      addEventListener: (event: string, fn: KeyListener, capture?: boolean) => {
        listeners.push({ event, fn, capture });
      },
      removeEventListener: (event: string, fn: KeyListener, capture?: boolean) => {
        listeners = listeners.filter((l) => !(l.event === event && l.fn === fn && l.capture === capture));
      },
    };
  });
  afterEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).document;
    delete (globalThis as unknown as Record<string, unknown>).window;
  });

  it('keydown 监听注册在捕获阶段；Esc 时 preventDefault 且触发 onCancel，别的键不触发', () => {
    const onCancel = vi.fn();
    mount(ConfirmDialog, { title: '删除 2 个对话', onConfirm: vi.fn(), onCancel });

    const l = listeners.find((x) => x.event === 'keydown');
    expect(l).toBeDefined();
    expect(l!.capture).toBe(true);

    const preventDefault = vi.fn();
    l!.fn({ key: 'Escape', preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);

    // 正向对照：别的键不触发 onCancel、也不 preventDefault——证明上面那次确实是 Escape 分支走的。
    onCancel.mockClear();
    const preventDefault2 = vi.fn();
    l!.fn({ key: 'Enter', preventDefault: preventDefault2 });
    expect(onCancel).not.toHaveBeenCalled();
    expect(preventDefault2).not.toHaveBeenCalled();
  });

  it('卸载时用同样的 capture=true 摘掉监听，不会留下一个摘不掉的幽灵监听器', () => {
    const onCancel = vi.fn();
    const m = mount(ConfirmDialog, { title: '删除 2 个对话', onConfirm: vi.fn(), onCancel });
    expect(listeners.some((l) => l.event === 'keydown')).toBe(true);

    m.unmount();
    expect(listeners.some((l) => l.event === 'keydown')).toBe(false);
  });
});
