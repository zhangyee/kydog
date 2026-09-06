/**
 * 译文块的行距处理（spec 2026-09-06 §3）。
 *
 * 块矩形是原文字身框的并集；译文按 LINE_HEIGHT 排时每个行框比字形高出 LEAD 倍字号，这部分是
 * **空白**，上下各一半，不必落在块内。测量比较的是字形跨度，渲染把 div 上移半个 LEAD 并加高
 * 一个 LEAD——字形仍落在原矩形内，溢出的只是行距。覆盖矩形（RightPage / groupGeometry）不动。
 */
export const LINE_HEIGHT = 1.5;
export const LEAD = LINE_HEIGHT - 1;

/** 测量宿主的 scrollHeight → 字形跨度（减掉首行上方与末行下方的半行距）。 */
export function glyphHeight(scrollHeight: number, fontPx: number): number {
  return scrollHeight - LEAD * fontPx;
}

/** 块 div 的 top / height（未缩放 pt）。fontPt = fontSize × SIZE_MUL × fit。 */
export function blockFrame(b: { y: number; height: number }, fontPt: number): { top: number; height: number } {
  return { top: b.y - (LEAD / 2) * fontPt, height: b.height + LEAD * fontPt };
}
