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
  const content = {} as Element;
  const el = {
    firstElementChild: content,
    scrollHeight: opts.scrollHeight,
    clientHeight: opts.clientHeight,
    get scrollTop() { return top; },
    set scrollTop(v: number) { top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)); },
    addEventListener: (type: string, fn: () => void) => { if (type === 'scroll') listeners.add(fn); },
    removeEventListener: (type: string, fn: () => void) => { if (type === 'scroll') listeners.delete(fn); },
  };
  return {
    el,
    content,
    /** 离底还有多远。0 = 贴底。 */
    away: () => el.scrollHeight - el.clientHeight - el.scrollTop,
    /** 内容长高（流式输出、工具输出展开……）。 */
    grow: (px: number) => { el.scrollHeight += px; },
    /** 内容变矮（折叠处理过程……）：浏览器会把超出新上界的 scrollTop 夹下来，这里照做。 */
    shrink: (px: number) => { el.scrollHeight -= px; el.scrollTop = Math.min(el.scrollTop, el.scrollHeight - el.clientHeight); },
    /** 用户滚到某处：改位置并**当场**派发 scroll。 */
    userScrollTo: (v: number) => { el.scrollTop = v; for (const fn of listeners) fn(); },
    /**
     * 用户滚到某处，但 scroll 事件**还没派发**。浏览器里 scroll 事件是下一帧才到的，
     * 这中间流式输出完全可能先提交一次渲染 —— 下面「竞态」那几条用例就停在这一步。
     */
    scrollWithoutEvent: (v: number) => { el.scrollTop = v; },
    /** 补派那次迟到的 scroll 事件。 */
    flushScrollEvent: () => { for (const fn of listeners) fn(); },
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
 * 已知竞态：scrollTop 被改了（用户第一下滚轮、程序赋值），scroll 事件要到下一帧才派发；这中间
 * 流式输出提交了一次渲染，afterRender 若还拿旧的 sticky 判，就把用户刚滚走的位置拉回底部
 * （e2e/29 在 CI 上稳定复现过：期望 scrollTop 0，实际被拉回 476）。
 * 判据是协议层事实：scrollTop 与状态机自己上一次写入 / 观察到的不一样 = 有人动过它。
 */
describe('createStickyScroll：scroll 事件还没到时先渲染了一次', () => {
  it('第一下滚动的事件还没到、先来了一次渲染：按改后的位置判定，不拉回底部', () => {
    const s = scroller({ scrollHeight: 1000, clientHeight: 400 });
    const ctl = createStickyScroll();
    ctl.jumpToBottom(s.el);
    expect(ctl.sticky).toBe(true);

    s.scrollWithoutEvent(0);   // 用户翻到顶，事件还在路上
    s.grow(300);               // 同一帧里流式输出提交了一次渲染
    ctl.afterRender(s.el);
    expect(s.el.scrollTop).toBe(0);
    expect(ctl.sticky).toBe(false);

    // 迟到的事件随后到：结论不变，之后继续长高也不动它
    s.flushScrollEvent();
    ctl.onScroll(s.el);
    s.grow(300);
    ctl.afterRender(s.el);
    expect(s.el.scrollTop).toBe(0);
  });

  it('位置动了但仍在阈值内、同一帧内容又长高：按长高之前的内容判定，照旧跟随', () => {
    const s = scroller({ scrollHeight: 1000, clientHeight: 400 });
    const ctl = createStickyScroll();
    ctl.jumpToBottom(s.el);
    s.scrollWithoutEvent(s.el.scrollTop - 10);   // 只往上挪了 10 px，离底 10 < 阈值
    s.grow(500);
    // 前提：按长高之后的内容看已经离底很远 —— 用它判的话会误判成翻走
    expect(s.away()).toBeGreaterThan(STICKY_THRESHOLD_PX);
    ctl.afterRender(s.el);
    expect(s.away()).toBe(0);
    expect(ctl.sticky).toBe(true);
  });

  it('内容变矮、浏览器把 scrollTop 夹下来：这不是用户翻走，照旧跟随', () => {
    const s = scroller({ scrollHeight: 1000, clientHeight: 400 });
    const ctl = createStickyScroll();
    ctl.jumpToBottom(s.el);
    const top = s.el.scrollTop;
    s.shrink(300);
    // 前提：位置确实被夹动了（否则下面测不到「位置变了」那条分支）
    expect(s.el.scrollTop).toBe(top - 300);
    ctl.afterRender(s.el);
    expect(ctl.sticky).toBe(true);
    s.grow(200);
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

  /** 最近一次渲染里 hook 返回的东西（按钮靠它决定在不在场、点了调谁）。 */
  let last: { following: boolean; jumpToBottom: () => void };

  function mountHook(s: ReturnType<typeof scroller>, props: P) {
    const ref = { current: s.el as unknown as HTMLElement };
    function Harness({ tail, threadId }: P) {
      last = useAutoScroll(ref, tail, threadId);
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

  it('内容在子组件里长高、父组件没有重渲染：仍跟到底', () => {
    const observed: Element[] = [];
    let notifyResize: (() => void) | undefined;
    class FakeResizeObserver {
      constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {
        notifyResize = () => this.callback([], this as unknown as ResizeObserver);
      }
      observe(target: Element) { observed.push(target); }
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    try {
      const s = scroller({ scrollHeight: 2000, clientHeight: 400 });
      const m = mountHook(s, { tail: 1, threadId: 't1' });
      expect(s.away()).toBe(0);
      expect(observed).toContain(s.content);

      s.grow(300); // MessageList 自己更新；ThreadView 不重渲染
      expect(s.away()).toBe(300);
      notifyResize?.();
      expect(s.away()).toBe(0);
      m.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('滚动事件还没到时先重渲染了一次（流式输出）：不把刚滚走的位置拉回底部', () => {
    const s = scroller({ scrollHeight: 2000, clientHeight: 400 });
    const m = mountHook(s, { tail: 1, threadId: 't1' });
    expect(s.away()).toBe(0);
    s.scrollWithoutEvent(0);
    s.grow(300);
    m.rerender({ tail: 1, threadId: 't1' });
    expect(s.el.scrollTop).toBe(0);
  });

  it('滚动容器晚一点才出现（新对话先是空状态）：它一出现就挂上监听，翻走照样认', () => {
    // 回归点：监听原来只在挂载时挂一次，而新建对话那一刻列表还不在（空状态），
    // 于是那次 effect 空跑、再也不回来——用户之后怎么翻，状态机都不知道，按钮永远不出现。
    const s = scroller({ scrollHeight: 2000, clientHeight: 400 });
    const ref: { current: HTMLElement | null } = { current: null };
    function Harness({ tail, threadId }: P) {
      last = useAutoScroll(ref as { current: HTMLElement | null }, tail, threadId);
      return null;
    }
    const m = mount(Harness, { tail: 1, threadId: 't1' });
    expect(s.listeners()).toBe(0);          // 容器还不在，没什么可挂的

    ref.current = s.el as unknown as HTMLElement;
    m.rerender({ tail: 1, threadId: 't1' });
    expect(s.listeners()).toBe(1);          // 一出现就挂上，且只挂一次
    m.rerender({ tail: 1, threadId: 't1' });
    expect(s.listeners()).toBe(1);

    readAway(s);
    m.rerender({ tail: 1, threadId: 't1' });
    expect(last.following).toBe(false);     // 监听真的在工作
  });

  it('返回的 following 跟着状态机走：贴底 true、翻走 false、跳底之后回到 true', () => {
    const s = scroller({ scrollHeight: 2000, clientHeight: 400 });
    const m = mountHook(s, { tail: 1, threadId: 't1' });
    expect(last.following).toBe(true);

    // 翻走：scroll 事件落地之后，下一次渲染读到的就是 false（按钮据此出现）
    readAway(s);
    m.rerender({ tail: 1, threadId: 't1' });
    expect(last.following).toBe(false);

    // 只是内容又长高、用户没动：仍然不跟随，following 保持 false
    s.grow(300);
    m.rerender({ tail: 1, threadId: 't1' });
    expect(last.following).toBe(false);

    // 用户自己滚回底部（scroll 事件）：不用点按钮也恢复跟随
    s.userScrollTo(s.el.scrollHeight - s.el.clientHeight);
    m.rerender({ tail: 1, threadId: 't1' });
    expect(last.following).toBe(true);
  });

  it('返回的 jumpToBottom：翻走状态下调它 → 跳底、following 回到 true、之后继续跟随', () => {
    const s = scroller({ scrollHeight: 2000, clientHeight: 400 });
    const m = mountHook(s, { tail: 1, threadId: 't1' });
    readAway(s);
    m.rerender({ tail: 1, threadId: 't1' });
    expect(last.following).toBe(false);
    expect(s.el.scrollTop).toBe(0);

    last.jumpToBottom();
    expect(s.away()).toBe(0);
    m.rerender({ tail: 1, threadId: 't1' });
    expect(last.following).toBe(true);

    // 恢复跟随之后，内容再长高就跟到底（证明它恢复的是状态机本身，不只是那个布尔量）
    s.grow(300);
    m.rerender({ tail: 1, threadId: 't1' });
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
