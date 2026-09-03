import type { PageSize } from './pageLayout';

/**
 * 窗口内所有页所有栏的像素上限。峰值是它的两倍——双缓冲顶替前有两层同时在。
 * 4.8e7 px × 4 B ≈ 192 MiB 稳态、384 MiB 峰值。用真实文档量过之后可以调（spec §17 第 2 项）。
 */
export const WINDOW_BUDGET_PX = 4.8e7;

export type WindowInput = {
  sizes: PageSize[];           // 索引 k 对应页号 k+1
  tops: number[];              // unitLayout 的输出，scale 1 下的顶边偏移
  scrollTop: number;           // px
  clientHeight: number;        // px
  visualScale: number;
  dpr: number;
  columns: number;             // 1 = 单栏，2 = 双栏
  editingPage: number | null;  // 1-based；正在编辑文字注的页
  budgetPx?: number;           // 默认 WINDOW_BUDGET_PX
};

export type WindowResult = { pages: Set<number>; rasterScale: number };

/**
 * 窗口与栅格分辨率一起算出来（spec §8.2）。
 *
 * 关键在顺序：先定必保集合（可见页 ∪ 正在编辑的页），再让 rasterScale 恰好使必保集合装进预算，
 * 最后拿剩下的预算向外扩窗口。反过来先定 rasterScale 再挑页，必保集合就可能装不下——
 * 而它是「必保」，没有取舍余地，只能让分辨率让步。
 *
 * 可见页用 visualScale 判定而不是 rasterScale：屏幕上的版面尺寸永远是 visualScale
 * （rasterScale 只决定位图多细，外层 CSS zoom 负责补上差额），否则这里会循环依赖。
 */
export function computeWindow(i: WindowInput): WindowResult {
  const n = i.sizes.length;
  const budget = i.budgetPx ?? WINDOW_BUDGET_PX;
  if (n === 0) return { pages: new Set(), rasterScale: i.visualScale };

  const s = i.visualScale;
  const top = i.scrollTop;
  const bottom = i.scrollTop + i.clientHeight;

  // 可见页：页的 [顶, 底] 与视口 [top, bottom] 有交集
  const must = new Set<number>();
  let nearest = 1;
  let nearestGap = Infinity;
  for (let k = 0; k < n; k++) {
    const a = i.tops[k] * s;
    const b = (i.tops[k] + i.sizes[k].h) * s;
    if (b > top && a < bottom) must.add(k + 1);
    const gap = a > bottom ? a - bottom : top > b ? top - b : 0;
    if (gap < nearestGap) { nearestGap = gap; nearest = k + 1; }
  }
  // 视口整个落在页间留白或首尾留白里：取最近的一页，不返回空集（返回空集会让整屏没有内容）
  if (must.size === 0) must.add(nearest);
  if (i.editingPage != null && i.editingPage >= 1 && i.editingPage <= n) must.add(i.editingPage);

  // rasterScale：反解让必保集合恰好装进预算的上限 cap，即 A·(cap·dpr)²·columns = budget。
  // rasterScale = min(visualScale, cap) 之后，必保集合的像素永远 ≤ budget（等号只在
  // visualScale ≥ cap 时取到）——所以必保集合必然装得下，不需要任何「装不下就踢页」的冲突规则。
  let A = 0;
  for (const p of must) A += i.sizes[p - 1].w * i.sizes[p - 1].h;
  const cap = Math.sqrt(budget / (i.columns * A)) / i.dpr;
  const rasterScale = Math.min(i.visualScale, cap);

  const px = (p: number) =>
    i.sizes[p - 1].w * i.sizes[p - 1].h * (rasterScale * i.dpr) ** 2 * i.columns;

  const pages = new Set(must);
  let usedPx = 0;
  for (const p of must) usedPx += px(p);

  // 向外扩张：从 must 集合的两端各留一个「下一候选」指针（hi 向后即页号更大，lo 向前）。
  // 用单个 turnHi 标志在两个指针间交替，优先给 hi（向下滚是更常见的方向）；
  // 一侧到了文档边界或它的下一页会让 usedPx 超预算，就永久关闭那一侧（不再重试），
  // 但另一侧继续——两侧都关闭时循环自然结束。这样保证了三条行为：
  //   1. must 已经在 pages 里，扩张只加不减；
  //   2. 每次真正推进的都是"轮到的那一侧"，退化为单侧还开着就单侧一直走；
  //   3. 任何一步会超预算，那一步不发生，对应方向就此打住。
  let hi = Math.max(...must) + 1;
  let lo = Math.min(...must) - 1;
  let hiOpen = hi <= n;
  let loOpen = lo >= 1;
  let turnHi = true;
  while (hiOpen || loOpen) {
    const useHi = hiOpen && (turnHi || !loOpen);
    if (useHi) {
      const cost = px(hi);
      if (usedPx + cost > budget) { hiOpen = false; } else {
        pages.add(hi); usedPx += cost; hi += 1; hiOpen = hi <= n;
      }
    } else {
      const cost = px(lo);
      if (usedPx + cost > budget) { loOpen = false; } else {
        pages.add(lo); usedPx += cost; lo -= 1; loOpen = lo >= 1;
      }
    }
    turnHi = !turnHi;
  }

  return { pages, rasterScale };
}
