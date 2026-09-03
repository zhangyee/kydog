// pdf.js getTextContent 的文本项 → 按行归并（spec §6.3）。
// 项的 transform[4] / [5] 是基线起点（PDF 用户坐标，y 向上），width / height 是宽与字高；
// 坐标一律交给 viewport.convertToViewportPoint 换算，不手算（MediaBox 原点、/Rotate 都由它处理）。

export type TextItemLike = { str: string; transform: number[]; width: number; height: number; hasEOL: boolean };
export type ViewportLike = { convertToViewportPoint(x: number, y: number): number[] };
export type LineItem = { x1: number; x2: number; str: string };
export type TextLine = { y: number; top: number; bottom: number; items: LineItem[] };

export function textLines(items: TextItemLike[], viewport: ViewportLike): TextLine[] {
  const lines: TextLine[] = [];
  let cur: { top: number; bottom: number; items: LineItem[] } | null = null;
  const flush = () => {
    if (!cur) return;
    cur.items.sort((a, b) => a.x1 - b.x1);
    lines.push({ y: (cur.top + cur.bottom) / 2, top: cur.top, bottom: cur.bottom, items: cur.items });
    cur = null;
  };
  for (const it of items) {
    if (it.str.length > 0) {
      const bx = it.transform[4];
      const by = it.transform[5];
      const [ax, ay] = viewport.convertToViewportPoint(bx, by);
      const [cx, cy] = viewport.convertToViewportPoint(bx + it.width, by + it.height);
      const top = Math.min(ay, cy);
      const bottom = Math.max(ay, cy);
      if (!cur) cur = { top, bottom, items: [] };
      else { cur.top = Math.min(cur.top, top); cur.bottom = Math.max(cur.bottom, bottom); }
      cur.items.push({ x1: Math.min(ax, cx), x2: Math.max(ax, cx), str: it.str });
    }
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}
