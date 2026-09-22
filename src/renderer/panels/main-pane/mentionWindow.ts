/**
 * @ 列表只画滚动视口里的那几行（spec §3.5）：逐级浏览一层可能就有成千上万条，数据不设上限，
 * 但 DOM 里只有视口内的行（上下各多画几行），其余用占位撑开。行高固定，所以全是算术。
 */

export const MENTION_ROW_HEIGHT = 28;
export const MENTION_VIEWPORT_MAX = 320;
export const MENTION_OVERSCAN = 4;

/** 列表滚动区的高度：条目撑不满时按条数，撑满了封顶。 */
export function mentionViewportHeight(count: number, rowHeight = MENTION_ROW_HEIGHT, max = MENTION_VIEWPORT_MAX): number {
  return Math.min(Math.max(0, count) * rowHeight, max);
}

/**
 * 要画的行 [start, end)。`scrollTop` 先夹到浏览器实际能滚到的范围：条目刚变少时，状态里的 scrollTop
 * 可能还是旧的（滚动事件还没回来），按它算会一行都不画。
 */
export function visibleRange(a: { scrollTop: number; viewportHeight: number; rowHeight: number; count: number; overscan: number }): { start: number; end: number } {
  if (a.count <= 0) return { start: 0, end: 0 };
  const maxTop = Math.max(0, a.count * a.rowHeight - a.viewportHeight);
  const top = Math.min(Math.max(0, a.scrollTop), maxTop);
  const first = Math.floor(top / a.rowHeight);
  const last = Math.ceil((top + a.viewportHeight) / a.rowHeight);
  return { start: Math.max(0, first - a.overscan), end: Math.min(a.count, last + a.overscan) };
}

/** 让第 `index` 行整行露出来要滚到的 scrollTop；已经露着就原样返回。 */
export function revealScrollTop(a: { scrollTop: number; viewportHeight: number; rowHeight: number; index: number }): number {
  const top = a.index * a.rowHeight;
  const bottom = top + a.rowHeight;
  if (top < a.scrollTop) return top;
  if (bottom > a.scrollTop + a.viewportHeight) return bottom - a.viewportHeight;
  return a.scrollTop;
}
