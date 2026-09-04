export type RGB = [number, number, number];

/**
 * 页背景色：四角 + 四边中点，各向内缩 inset 像素，八点颜色**完全相同**才采用。
 *
 * 为什么是页级而不是逐块取矩形外沿：页角几乎一定是背景，比块周围稳得多（块外沿常压着相邻行的
 * 抗锯齿），也便宜得多——一页取一次，所有块共用。
 *
 * 为什么是「全同才用」而不是众数加占比阈值：阈值就是拟合。二值判定取不到时退回 --color-paper，
 * 那是一条走得通的降级；猜错底色则会在深色页上留下一块白斑。
 *
 * 已知取不到的情况：局部底色（水印、彩色栏底）、四边有出血图的页。写在 spec §6。
 */
export function pageBackground(
  read: (x: number, y: number) => RGB,
  w: number, h: number, inset = 2,
): RGB | null {
  const x0 = inset, x1 = w - 1 - inset, y0 = inset, y1 = h - 1 - inset;
  if (x1 <= x0 || y1 <= y0) return null;
  const xm = Math.floor((x0 + x1) / 2), ym = Math.floor((y0 + y1) / 2);
  const points: [number, number][] = [
    [x0, y0], [x1, y0], [x0, y1], [x1, y1],
    [xm, y0], [xm, y1], [x0, ym], [x1, ym],
  ];
  const first = read(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const c = read(points[i][0], points[i][1]);
    if (c[0] !== first[0] || c[1] !== first[1] || c[2] !== first[2]) return null;
  }
  return first;
}
