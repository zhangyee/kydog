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

/**
 * 空数组不返回垃圾矩形而是抛：`Math.min()` 无参回 `Infinity`、`Math.max()` 回 `-Infinity`，
 * 于是 `unionRect([])` 会安静地产出 `{x: Infinity, y: Infinity, w: -Infinity, h: -Infinity}`
 * ——一个既盖不住任何东西、又会污染下游一切算术的坐标（不变量 #2 的落点：坐标只由我们算，
 * 那就不能有一条路径算得出这种值）。
 *
 * 今天两个调用点（groupGeometry、buildBlocks）都自己先滤掉了空组，所以这行抛不出来；正因为
 * 如此，将来多一个忘了过滤的调用点时，失败必须是响的，而不是一块画在无穷远处的覆盖矩形。
 */
export function unionRect(rs: Rect[]): Rect {
  if (rs.length === 0) throw new Error('unionRect: 空的矩形数组没有并集');
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
