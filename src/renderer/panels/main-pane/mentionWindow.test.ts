import { describe, it, expect } from 'vitest';
import { visibleRange, revealScrollTop, mentionViewportHeight, mentionMenuWidth, MENTION_MENU_WIDTH } from './mentionWindow';

/** @ 列表只画滚动视口里的那几行（spec §3.5）。固定行高下的纯算术。 */

const ROW = 28;
const VIEW = 320;

describe('visibleRange', () => {
  it('视口里的行（上下各多画 overscan 行），end 不含', () => {
    expect(visibleRange({ scrollTop: 0, viewportHeight: VIEW, rowHeight: ROW, count: 1000, overscan: 4 })).toEqual({ start: 0, end: 16 });
    // 滚到第 100 行：视口盖住 100..111（3120/28 = 111.4），再各多 4 行
    expect(visibleRange({ scrollTop: 2800, viewportHeight: VIEW, rowHeight: ROW, count: 1000, overscan: 4 })).toEqual({ start: 96, end: 116 });
    // 停在半行上：上面那半行也算在视口里
    expect(visibleRange({ scrollTop: 2814, viewportHeight: VIEW, rowHeight: ROW, count: 1000, overscan: 0 })).toEqual({ start: 100, end: 112 });
  });

  it('条数不多：全画；没有条目：什么都不画', () => {
    expect(visibleRange({ scrollTop: 0, viewportHeight: 84, rowHeight: ROW, count: 3, overscan: 4 })).toEqual({ start: 0, end: 3 });
    expect(visibleRange({ scrollTop: 0, viewportHeight: 0, rowHeight: ROW, count: 0, overscan: 4 })).toEqual({ start: 0, end: 0 });
  });

  it('scrollTop 超出内容（条目刚变少、滚动事件还没回来）：按浏览器会夹到的位置算，末尾那几行照样画出来；负数按 0', () => {
    // 20 行 × 28 = 560，视口 320 → 最多滚到 240（第 8 行起）
    expect(visibleRange({ scrollTop: 5000, viewportHeight: VIEW, rowHeight: ROW, count: 20, overscan: 4 })).toEqual({ start: 4, end: 20 });
    expect(visibleRange({ scrollTop: -50, viewportHeight: VIEW, rowHeight: ROW, count: 1000, overscan: 4 })).toEqual({ start: 0, end: 16 });
  });
});

describe('revealScrollTop', () => {
  it('那一行已经整行在视口里：不动', () => {
    expect(revealScrollTop({ scrollTop: 0, viewportHeight: VIEW, rowHeight: ROW, index: 0 })).toBe(0);
    expect(revealScrollTop({ scrollTop: 280, viewportHeight: VIEW, rowHeight: ROW, index: 12 })).toBe(280);
  });
  it('在视口下面：滚到它的下沿刚好贴着视口下沿；在上面：滚到它的上沿', () => {
    expect(revealScrollTop({ scrollTop: 0, viewportHeight: VIEW, rowHeight: ROW, index: 11 })).toBe(12 * ROW - VIEW);
    expect(revealScrollTop({ scrollTop: 0, viewportHeight: VIEW, rowHeight: ROW, index: 500 })).toBe(501 * ROW - VIEW);
    expect(revealScrollTop({ scrollTop: 2800, viewportHeight: VIEW, rowHeight: ROW, index: 50 })).toBe(50 * ROW);
  });
  it('滚过去之后，那一行一定在 visibleRange 里（不带 overscan）', () => {
    for (const [from, index] of [[0, 999], [27000, 3], [1000, 40], [1000, 45]] as const) {
      const top = revealScrollTop({ scrollTop: from, viewportHeight: VIEW, rowHeight: ROW, index });
      const r = visibleRange({ scrollTop: top, viewportHeight: VIEW, rowHeight: ROW, count: 1000, overscan: 0 });
      expect(index >= r.start && index < r.end, `from=${from} index=${index}`).toBe(true);
    }
  });
});

describe('mentionMenuWidth', () => {
  it('固定宽度，不随内容变；右边放不下时收到视口里（留一点边距），再窄也不为负', () => {
    expect(mentionMenuWidth(100, 1200)).toBe(MENTION_MENU_WIDTH);
    expect(mentionMenuWidth(100, 400)).toBe(400 - 100 - 12);
    expect(mentionMenuWidth(500, 400)).toBe(0);
  });
});

describe('mentionViewportHeight', () => {
  it('条目撑不满时按条数，撑满了封顶在最大高度', () => {
    expect(mentionViewportHeight(3)).toBe(3 * ROW);
    expect(mentionViewportHeight(1000)).toBe(VIEW);
  });
});
