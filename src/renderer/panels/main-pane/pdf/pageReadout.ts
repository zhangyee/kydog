import type { PageSize } from './pageLayout';

/**
 * 视口 [vTop, vBottom]（滚动内容坐标，CSS px）内可见高度最大的页；并列取靠前的；
 * 都不可见时取离视口最近的那页（重叠高度为负，取最大即最近）；空文档返回 1。
 *
 * 输入是 tops/sizes/scale 而不是量出来的 DOM 矩形：`unitLayout` 算出的 tops 乘以 visualScale
 * 恒等于行的真实顶边（gap/padding 按 layer.scale 等比、外层 zoom 抵掉），所以布局模型本来就是
 * 权威事实，量 DOM 是拿派生物当事实。代价还很贵：那要对每一页做一次 getBoundingClientRect，
 * 200 页的文档就是每个滚动帧 200 次强制布局——虚拟化正是为了撑住更长的文档，不能把 O(n)
 * 从位图搬到 DOM 上。
 */
export function mostVisiblePage(
  tops: number[],
  sizes: PageSize[],
  scale: number,
  vTop: number,
  vBottom: number,
): number {
  let best = 1;
  let bestH = -Infinity;
  for (let k = 0; k < tops.length; k++) {
    const h = Math.min((tops[k] + sizes[k].h) * scale, vBottom) - Math.max(tops[k] * scale, vTop);
    if (h > bestH) { bestH = h; best = k + 1; }
  }
  return best;
}
