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
    // y 取「基线上方四分之一个字高」，不是字身框的正中。
    // 字身框是 [基线, 基线 + 字高]，正中落在半个字高处 —— 那是大写字母的腰部，比人眼看到的
    // 「这行字的中间」高出一截：小写字母只到 x 高（≈ 0.5 字高），还有 g/y 的降部伸到基线以下。
    // 拿正中当中线，高亮就整体偏上、盖住行上方的空白而露出字的下半（用户实测的偏移）。
    // 四分之一处约等于 x 高的中点，正是记号笔该压的位置。
    const emHeight = cur.bottom - cur.top;
    lines.push({ y: cur.bottom - emHeight / 4, top: cur.top, bottom: cur.bottom, items: cur.items });
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
