export type PageRect = { page: number; top: number; bottom: number };

/** 视口 [vTop, vBottom] 内可见高度最大的页；并列取靠前的；都不可见时取离视口最近的那页；空表返回 1。 */
export function mostVisiblePage(rects: PageRect[], vTop: number, vBottom: number): number {
  let best = rects[0]?.page ?? 1;
  let bestH = -Infinity;
  for (const r of rects) {
    const h = Math.min(r.bottom, vBottom) - Math.max(r.top, vTop);
    if (h > bestH) { bestH = h; best = r.page; }
  }
  return best;
}
