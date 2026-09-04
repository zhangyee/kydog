import type { PageSize } from './pageLayout';

/**
 * 窗口内**每一栏**（所有页在该栏上叠加）的像素上限——不是所有栏合计。总量 = 栏数 × 这个值，这
 * 本来就是事实：两倍的画面就是两倍的位图（v6 订正，spec §8.2「v6 订正」；Yee 2026-09-04 拍板）。
 * **不是恒等式**——真实的界有三档（spec §8.2「v4 订正」，界口径同为「每栏」）：
 *
 *   稳态（不跨页边界、且缩放至少提交过一次）  ≤ COLUMN_BUDGET_PX / 栏
 *   跨页边界 / 还没提交过缩放的初始层         ≤ 2 × / 栏
 *   双缓冲顶替前的瞬时（两层并存）            ≤ 2 × 上面两者 → 最坏 4 × / 栏
 *
 * 为什么会有 2×：`layer.scale` 只在缩放提交的那一刻被赋值，纯滚动永远不重新对账，层的初值又
 * 写死 1。于是「按一页可见时反解出的 rasterScale 栅格化，随后滚到两页都可见」这类日常路径下，
 * 屏幕上确实同时挂着两页 × 那个分辨率 = 两倍预算。
 *
 * 接受 2× 而不是改算法，是刻意取舍（Yee 2026-09-04 拍板）：让 cap 改从「任意滚动位置下可能同时
 * 可见的页」的滑窗最大面积反解，能让「恒 ≤ 预算」成立，但那会让**每一次**缩放都按峰值保守，
 * 用常见情况的清晰度去换边界情况的严格性。也不用「漂移超过 X% 就重新提交」——那是阈值 proxy，
 * 而且会让每次跨页边界都重栅格化。改为把预算减半当安全余量。
 *
 * 4.8e7 px × 4 B ≈ 192 MiB 稳态、768 MiB 最坏，**每栏**。多栏是这个数的整数倍，不是这个数本身
 * 除以栏数——按栏数各开各的预算，锐利度因此与栏数无关，由构造保证。用真实文档量过之后可以调
 * 常数本身（spec §17 第 2 项）。
 */
export const COLUMN_BUDGET_PX = 4.8e7;

export type WindowInput = {
  sizes: PageSize[];           // 索引 k 对应页号 k+1
  tops: number[];              // unitLayout 的输出，scale 1 下的顶边偏移
  scrollTop: number;           // px
  clientHeight: number;        // px
  visualScale: number;
  dpr: number;
  editingPage: number | null;  // 1-based；正在编辑文字注的页
  budgetPx?: number;           // 默认 COLUMN_BUDGET_PX，每栏
};

export type WindowResult = {
  pages: Set<number>;    // 要挂载的页（可见 ∪ editingPage ∪ 预算内的预取页）
  visible: Set<number>;  // 仅与视口相交的页；双缓冲按它判定顶替
  rasterScale: number;
};

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
  const budget = i.budgetPx ?? COLUMN_BUDGET_PX;
  if (n === 0) return { pages: new Set(), visible: new Set(), rasterScale: i.visualScale };

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
  // visible 在加 editingPage 之前定格：editingPage 只是「钉住别卸载」，不是屏幕上看得见的东西。
  // 双缓冲的顶替条件按 visible 判定，把 editingPage 算进去就可能永远等一页视口外的渲染回调，
  // 每次缩放都卡满 PROMOTE_TIMEOUT。（留白兜底挑出来的 nearest 算可见：那一页就是屏幕上的内容。）
  const visible = new Set(must);
  if (i.editingPage != null && i.editingPage >= 1 && i.editingPage <= n) must.add(i.editingPage);

  // rasterScale：反解让必保集合（每栏）恰好装进预算的上限 cap，即 A·(cap·dpr)² = budget。
  // rasterScale = min(visualScale, cap) 之后，必保集合每栏的像素永远 ≤ budget（等号只在
  // visualScale ≥ cap 时取到）——所以必保集合必然装得下，不需要任何「装不下就踢页」的冲突规则。
  let A = 0;
  for (const p of must) A += i.sizes[p - 1].w * i.sizes[p - 1].h;
  const cap = Math.sqrt(budget / A) / i.dpr;
  const rasterScale = Math.min(i.visualScale, cap);

  const px = (p: number) =>
    i.sizes[p - 1].w * i.sizes[p - 1].h * (rasterScale * i.dpr) ** 2;

  const pages = new Set(must);
  let usedPx = 0;
  for (const p of must) usedPx += px(p);

  // 扩张的**空间上界**：向外最多扩到「视口上下各一个视口高度」，即总共覆盖 3 个视口高度的内容
  // 范围，与预算取 min（spec §8.2「v4 新增」）。
  //
  // 为什么需要第二条停止条件：只以「像素超预算」收手的话，预算就从上限变成了目标——缩放越小
  // 单页像素越少、能塞进去的页越多。实测 800 页 A4 在 visualScale 0.25 / dpr 1 下会挂满全部
  // 800 页：像素确实在预算内，炸的是别的（并发渲染任务全排在同一个 pdf.js worker 上、几百个
  // 标注层与 DOM 节点、几百个 page proxy）。
  //
  // 这是协议层的空间量——「用户要滚多远才需要新页」——不是时间窗，也不是拍脑袋的页数上限。
  //
  // 待实测（浏览器行为假设，不算关键决策；PdfFileTab.tsx 挂 ResizeObserver 那段注释里是同一个
  // 假设，两处都待验，判据相同）：clientHeight === 0 时的含义是「tab 被 display:none 隐藏，
  // Chromium 照样触发 ResizeObserver 且读数为 0」。判据：开两个 file tab、切到另一个 tab 让这
  // 个 PDF tab 变成 display:none，隐藏期间对它的滚动容器读 el.clientHeight 应为 0。若假设成立，
  // clientHeight === 0 因此自然退化成「没有视口」：带宽为 0，一页都不预取，窗口只剩必保集合。
  // 这与「视口落在页间留白里」是两件事——后者视口是真实存在的，带宽照常是 3 个视口高。若不
  // 成立，要重新核实这条退化路径。
  const bandTop = top - i.clientHeight;
  const bandBottom = bottom + i.clientHeight;
  const inBand = (p: number) =>
    (i.tops[p - 1] + i.sizes[p - 1].h) * s > bandTop && i.tops[p - 1] * s < bandBottom;

  // 向外扩张：从 must 集合的两端各留一个「下一候选」指针（hi 向后即页号更大，lo 向前）。
  // 用单个 turnHi 标志在两个指针间交替，优先给 hi（向下滚是更常见的方向）；
  // 一侧到了文档边界、或它的下一页出了空间上界、或会让 usedPx 超预算，就永久关闭那一侧
  // （不再重试），但另一侧继续——两侧都关闭时循环自然结束。这样保证了三条行为：
  //   1. must 已经在 pages 里，扩张只加不减（**必保集合不受空间上界约束**，它是「必保」）；
  //   2. 每次真正推进的都是"轮到的那一侧"，退化为单侧还开着就单侧一直走；
  //   3. 任何一步会超预算或出界，那一步不发生，对应方向就此打住。
  // 两条停止条件都可以永久关闭一侧，因为都是单调的：页号越往外，页离视口只会更远、
  // usedPx 只会更大。
  let hi = Math.max(...must) + 1;
  let lo = Math.min(...must) - 1;
  let hiOpen = hi <= n;
  let loOpen = lo >= 1;
  let turnHi = true;
  while (hiOpen || loOpen) {
    const useHi = hiOpen && (turnHi || !loOpen);
    if (useHi) {
      const cost = px(hi);
      if (!inBand(hi) || usedPx + cost > budget) { hiOpen = false; } else {
        pages.add(hi); usedPx += cost; hi += 1; hiOpen = hi <= n;
      }
    } else {
      const cost = px(lo);
      if (!inBand(lo) || usedPx + cost > budget) { loOpen = false; } else {
        pages.add(lo); usedPx += cost; lo -= 1; loOpen = lo >= 1;
      }
    }
    turnHi = !turnHi;
  }

  return { pages, visible, rasterScale };
}

const sameSet = (a: Set<number>, b: Set<number>): boolean => {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

/**
 * 两次窗口计算的结果是不是同一个窗口（挂哪些页、哪些可见、多细的位图，三者全同）。
 *
 * 存在的理由：窗口的输入里有一个每帧都变的量（滚动位置），而输出大多数帧不变。调用方拿它做
 * 「变了才 setState」的判据，纯滚动才不会每帧重渲染整棵子树。判的是输出本身，不是输入的
 * 变化幅度——没有阈值、没有近似。
 */
export function sameWindow(a: WindowResult, b: WindowResult): boolean {
  return a.rasterScale === b.rasterScale && sameSet(a.pages, b.pages) && sameSet(a.visible, b.visible);
}
