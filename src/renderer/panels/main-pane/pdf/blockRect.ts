// 译文块的覆盖矩形：RightPage 用它填色，groupGeometry 用它校验。**必须是同一份。**

export type Rect = { x: number; y: number; w: number; h: number };

/**
 * 覆盖矩形四周外扩的 pt 数。段落 bbox 常比实际墨迹紧一两点，不外扩会在块边缘留一圈没盖住的原文。
 *
 * 这是一个常数，不参与任何判定，只是让覆盖区略大于 bbox —— 不是阈值拟合（对照壳 spec §3.2）。
 */
export const BLOCK_PAD = 1.5;

export function paddedRect(r: Rect): Rect {
  return { x: r.x - BLOCK_PAD, y: r.y - BLOCK_PAD, w: r.w + 2 * BLOCK_PAD, h: r.h + 2 * BLOCK_PAD };
}

export function unionRect(rs: Rect[]): Rect {
  const x = Math.min(...rs.map((r) => r.x));
  const y = Math.min(...rs.map((r) => r.y));
  const x2 = Math.max(...rs.map((r) => r.x + r.w));
  const y2 = Math.max(...rs.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

/**
 * `of` 的中心点在不在 `r` 里。
 *
 * 用中心点而不是矩形相交：行的 bbox 取的是字身框（textLines 的 top/bottom），相邻两段本来就
 * 可能因降部沾边，行距紧一点连 BLOCK_PAD 都会让两个矩形相交——「相交即拒」会把完全正常的版面
 * 判死，加容差又是一个新阈值。中心点包含没有这个问题，也不需要任何常数。
 *
 * 代价说清楚：中心在外只保证那一行**不会被整行盖掉**，`r` 仍可能擦进它 bbox 的边缘一两点。
 * 那是 BLOCK_PAD 的既有取舍，agent 写的边车一样如此，不是本期引入的。
 */
export function containsCenter(r: Rect, of: Rect): boolean {
  const cx = of.x + of.w / 2;
  const cy = of.y + of.h / 2;
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
}
