import { describe, it, expect, vi } from 'vitest';
import { mount } from '../../../test-support/miniReact';

// 下半截要真的跑 useAutoScroll 这个 hook（miniReact，见 test-support/miniReact.ts）；
// 上半截的纯函数不碰 React，换掉 hook 对它们没有影响。
vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { isNearBottom, STICKY_THRESHOLD_PX, createStickyScroll, useAutoScroll } = await import('./useAutoScroll');

describe('isNearBottom', () => {
  it('距底部恰好 0（贴底）→ true', () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })).toBe(true);
  });

  it('距底部 < THRESHOLD → true', () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 - (STICKY_THRESHOLD_PX - 1) })).toBe(true);
  });

  it('距底部 = THRESHOLD → false（严格小于）', () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 - STICKY_THRESHOLD_PX })).toBe(false);
  });

  it('距底部 > THRESHOLD → false', () => {
    expect(isNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 })).toBe(false);
  });

  it('内容未撑满容器（scrollHeight == clientHeight, scrollTop=0）→ true', () => {
    expect(isNearBottom({ scrollHeight: 200, clientHeight: 200, scrollTop: 0 })).toBe(true);
  });

  it('THRESHOLD 是 64', () => {
    expect(STICKY_THRESHOLD_PX).toBe(64);
  });
});

/**
 * 假滚动容器。只做被测代码用得到的那几样，但两处照浏览器来：
 * - `scrollTop` 写进去会被夹到 `[0, scrollHeight - clientHeight]` —— 「跳底」写的是
 *   `scrollHeight`，真正落下的是最大可滚值，断言按「离底多远」算，不按写进去的数算；
 * - scroll 监听器真的挂上、真的能派发，hook 有没有接这条线是可以被看见的。
 */
function scroller(opts: { scrollHeight: number; clientHeight: number }) {
  const listeners = new Set<() => void>();
  let top = 0;
  const el = {
    scrollHeight: opts.scrollHeight,
    clientHeight: opts.clientHeight,
    get scrollTop() { return top; },
    set scrollTop(v: number) { top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)); },
    addEventListener: (type: string, fn: () => void) => { if (type === 'scroll') listeners.add(fn); },
    removeEventListener: (type: string, fn: () => void) => { if (type === 'scroll') listeners.delete(fn); },
  };
  return {
    el,
    /** 离底还有多远。0 = 贴底。 */
    away: () => el.scrollHeight - el.clientHeight - el.scrollTop,
    /** 内容长高（流式输出、工具输出展开……）。 */
    grow: (px: number) => { el.scrollHeight += px; },
    /**
     * 用户滚到某处：改位置并派发 scroll。浏览器里 scroll 事件是下一帧才派发的，
     * 这里合成一步 ——「改了位置、事件还没到就先渲染了一次」那条已知竞态不在这份用例的范围里。
     */
    userScrollTo: (v: number) => { el.scrollTop = v; for (const fn of listeners) fn(); },
    listeners: () => listeners.size,
  };
}

/**
 * 替代 e2e/29-auto-scroll 的三条主张，这里是判定那一半（纯状态机，不经 React）：
 * 贴底时跟随、翻走了就不动、新 text block / 新 user message 强制跳底。
 */
describe('createStickyScroll：贴底跟随的判定', () => {
  it('贴底或离底不到阈值时，内容长高 → 跟到底', () => {
    const s = scroller({ scrollHeight: 1000, clientHeight: 400 });
    const ctl = createStickyScroll();
    ctl.jumpToBottom(s.el);
    expect(s.away()).toBe(0);

    // 往上挪了一点、但没超过阈值：仍算贴底
    s.el.scrollTop -= STICKY_THRESHOLD_PX - 1;
    ctl.onScroll(s.el);
    expect(s.away()).toBe(STICKY_THRESHOLD_PX - 1);

    s.grow(500);
    // 前提：长高确实把底部推远了（不然下一条断言不证明任何事）
    expect(s.away()).toBe(500 + STICKY_THRESHOLD_PX - 1);
    ctl.afterRender(s.el);
    expect(s.away()).toBe(0);
  });

  it('用户翻走了（scroll 报告离底 ≥ 阈值）→ 内容再长也不动 scrollTop（先证明贴底时同样的长高会动它）', () => {
    const s = scroller({ scrollHeight: 1000, clientHeight: 400 });
    const ctl = createStickyScroll();
    ctl.jumpToBottom(s.el);

    // 正向：贴底时，同样的「长高 + 渲染」会把 scrollTop 往下推
    const before = s.el.scrollTop;
    s.grow(500);
    ctl.afterRender(s.el);
    expect(s.el.scrollTop).toBe(before + 500);

    // 恰好离底 = 阈值就已经算翻走（严格小于才贴底）
    s.el.scrollTop -= STICKY_THRESHOLD_PX;
    ctl.onScroll(s.el);
    const parked = s.el.scrollTop;
    s.grow(500);
    ctl.afterRender(s.el);
    expect(s.el.scrollTop).toBe(parked);

    // 翻到顶
    s.el.scrollTop = 0;
    ctl.onScroll(s.el);
    s.grow(500);
    expect(s.away()).toBeGreaterThan(STICKY_THRESHOLD_PX);
    ctl.afterRender(s.el);
    expect(s.el.scrollTop).toBe(0);
  });

  it('override：翻走状态下 jumpToBottom 照样跳底，并恢复跟随', () => {
    const s = scroller({ scrollHeight: 1000, clientHeight: 400 });
    const ctl = createStickyScroll();
    s.el.scrollTop = 0;
    ctl.onScroll(s.el);
    // 前提：确实处在 free-read —— 长高 + 渲染不动它，所以下面的跳底只能是 override 做的
    s.grow(500);
    ctl.afterRender(s.el);
    expect(s.el.scrollTop).toBe(0);

    ctl.jumpToBottom(s.el);
    expect(s.away()).toBe(0);

    // 跳底之后回到跟随：不必等下一次 scroll 事件
    s.grow(500);
    ctl.afterRender(s.el);
    expect(s.away()).toBe(0);
  });
});

/**
 * 接线那一半：真的跑 `useAutoScroll`，看 React 的几个时机有没有接到状态机上 ——
 * scroll 事件 → 反推 sticky，每次渲染后 → 贴底才跟随，tailSignal / threadId 变了 → 跳底。
 *
 * ref 由用例自己持有、指向假滚动容器；组件返回 null，所以 miniReact 不会拿它的假元素
 * 覆盖这个 ref。
 */
describe('useAutoScroll：React 的时机接到状态机上', () => {
  type P = { tail: number; threadId: string };

  function mountHook(s: ReturnType<typeof scroller>, props: P) {
    const ref = { current: s.el as unknown as HTMLElement };
    function Harness({ tail, threadId }: P) {
      useAutoScroll(ref, tail, threadId);
      return null;
    }
    return mount(Harness, props);
  }

  /** 进入 free-read：用户翻到顶，scroll 事件派发出去。 */
  function readAway(s: ReturnType<typeof scroller>) {
    s.userScrollTo(0);
    expect(s.away()).toBeGreaterThan(STICKY_THRESHOLD_PX);
  }

  it('挂载即到底；贴底时每次渲染后跟随；用户翻走之后重渲染不动 scrollTop', () => {
    const s = scroller({ scrollHeight: 2000, clientHeight: 400 });
    const m = mountHook(s, { tail: 1, threadId: 't1' });
    expect(s.listeners()).toBe(1);
    expect(s.away()).toBe(0);

    // 贴底：内容长高，下一次渲染跟到底（tailSignal 没变，靠的是每次渲染后那一步）
    s.grow(300);
    expect(s.away()).toBe(300);
    m.rerender({ tail: 1, threadId: 't1' });
    expect(s.away()).toBe(0);

    // 翻走：同样的长高 + 渲染，scrollTop 留在原地
    readAway(s);
    s.grow(300);
    m.rerender({ tail: 1, threadId: 't1' });
    expect(s.el.scrollTop).toBe(0);
  });

  it('tailSignal 变了（新 text block / 新 user message）→ free-read 里也跳底；只重渲染、tailSignal 没变就不跳', () => {
    const s = scroller({ scrollHeight: 2000, clientHeight: 400 });
    const m = mountHook(s, { tail: 1, threadId: 't1' });
    readAway(s);

    s.grow(300);
    m.rerender({ tail: 1, threadId: 't1' });
    expect(s.el.scrollTop).toBe(0);

    m.rerender({ tail: 2, threadId: 't1' });
    expect(s.away()).toBe(0);

    // 跳底之后恢复跟随
    s.grow(300);
    m.rerender({ tail: 2, threadId: 't1' });
    expect(s.away()).toBe(0);
  });

  it('换 thread → free-read 里也跳底', () => {
    const s = scroller({ scrollHeight: 2000, clientHeight: 400 });
    const m = mountHook(s, { tail: 1, threadId: 't1' });
    readAway(s);

    m.rerender({ tail: 1, threadId: 't1' });
    expect(s.el.scrollTop).toBe(0);

    m.rerender({ tail: 1, threadId: 't2' });
    expect(s.away()).toBe(0);
  });
});
