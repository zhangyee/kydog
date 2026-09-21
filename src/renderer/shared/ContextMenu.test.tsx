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

const { ContextMenu } = await import('./ContextMenu');

/**
 * 回归用例：portal 只搬了 DOM 节点，不搬事件路径——面板在 React 树上仍是发起右键那一行的子节点，
 * 面板上的点击 / 右键 / 按下不拦住冒泡的话会一路跑回行上的处理器（见 ContextMenu.tsx 里的注释）。
 */
beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).document = { body: {} };
  (globalThis as unknown as Record<string, unknown>).window = {
    innerWidth: 1000,
    innerHeight: 700,
    addEventListener() {},
    removeEventListener() {},
  };
});
afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).document;
  delete (globalThis as unknown as Record<string, unknown>).window;
});

describe('ContextMenu：面板拦住冒泡', () => {
  it('点击面板 → 拦住冒泡且关闭；右键面板 → 拦住冒泡但不关闭；mousedown → 拦住冒泡', () => {
    const onClose = vi.fn();
    const m = mount(ContextMenu, { at: { x: 10, y: 20 }, testId: 'cm', onClose, children: null });
    const panel = m.find('cm');

    const clickStop = vi.fn();
    (panel.props.onClick as (e: { stopPropagation: () => void }) => void)({ stopPropagation: clickStop });
    expect(clickStop).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);

    // 正向对照就放在同一条里：右键面板拦住冒泡（preventDefault + stopPropagation 都调了），
    // 但不应该顺手把菜单关掉——不然右键当场把自己关了。
    onClose.mockClear();
    const ctxPreventDefault = vi.fn();
    const ctxStop = vi.fn();
    (panel.props.onContextMenu as (e: { preventDefault: () => void; stopPropagation: () => void }) => void)({
      preventDefault: ctxPreventDefault,
      stopPropagation: ctxStop,
    });
    expect(ctxPreventDefault).toHaveBeenCalledTimes(1);
    expect(ctxStop).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    const downStop = vi.fn();
    (panel.props.onMouseDown as (e: { stopPropagation: () => void }) => void)({ stopPropagation: downStop });
    expect(downStop).toHaveBeenCalledTimes(1);
  });
});
