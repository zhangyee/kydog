import type { HighlightSegment } from '../../../../shared/pdfSidecar';
import type { TextLine } from './textLines';

export type Point = [number, number];

// 够得着的纵向范围：从字身框的上下沿再往外这么多。行与行的缝隙比它窄，所以缝里也归最近的行 ——
// 按住横向拖动时手稍微飘一下，直线不会在缝里突然脱开变成斜线。
const SNAP_MARGIN = 10;
// 起点到终点短于此就当没画：一次误点不该在论文上留一条标注。
const MIN_LENGTH = 4;

/** 这一行文字在横向上的跨度（items 已按 x 排序）。空行不会出现在行表里，兜底成「全宽」。 */
function lineSpan(l: TextLine): [number, number] {
  if (l.items.length === 0) return [-Infinity, Infinity];
  return [l.items[0].x1, l.items[l.items.length - 1].x2];
}

/**
 * 给「当前点的 y」和「这一笔的横向区间」挑一行：纵向够得着的行里，**先要横向有交叠**，再取纵向最近的。
 *
 * 横向那一步是为双栏论文：`hasEOL` 把左右两栏切成各自的行，同一高度上有两条行，只看 y 会挑到隔壁栏 ——
 * 画出来位置一样（同高），但 `text` 会按隔壁栏的项去拼，横向不交叠就拼成空串，等于把这一笔标到的原文丢了。
 */
function pickLine(y: number, x1: number, x2: number, lines: TextLine[]): number {
  let best = -1;
  let bestApart = 2;   // 1 = 横向没交叠，0 = 有交叠
  let bestDy = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const dy = y < l.top ? l.top - y : y > l.bottom ? y - l.bottom : 0;
    if (dy > SNAP_MARGIN) continue;
    const [lx1, lx2] = lineSpan(l);
    const apart = Math.min(x2, lx2) >= Math.max(x1, lx1) ? 0 : 1;
    if (apart > bestApart || (apart === bestApart && dy >= bestDy)) continue;
    best = i;
    bestApart = apart;
    bestDy = dy;
  }
  return best;
}

/** 该行上与 [x1, x2] 横向有交集的项，按阅读顺序拼接。 */
export function lineText(line: TextLine, x1: number, x2: number): string {
  return line.items.filter((it) => it.x2 >= x1 && it.x1 <= x2).map((it) => it.str).join('');
}

/**
 * 一笔 = 一条直线（GoodNotes 的「以直线绘制」那套，spec §6.3）。
 *
 * 落在文字上：贴到那一行的中线，x 取起点与当前点之间；离所有行都远（图表、公式、页边）：起点到当前点的
 * 直连线段，任意角度。贴哪一行看**当前点**而不是起点 —— 按住不放时可以上下滑到想标的那一行，看准了再松手。
 * 按下到松手之间每一帧都用它算预览，所见即所得，松手落的就是屏幕上那条。
 *
 * 早先是「采样点按最近的行分段」：一笔在同一行上会因为手抖切成好几截，段数取决于抖动而不是行表 ——
 * 那是把落盘结果交给了噪声。现在一笔恒定一段，由起点、当前点和行表三样确定。
 *
 * 太短则返回 null（这一笔丢弃）。
 */
export function straightSegment(from: Point, to: Point, lines: TextLine[]): HighlightSegment | null {
  if (Math.hypot(to[0] - from[0], to[1] - from[1]) < MIN_LENGTH) return null;
  const x1 = Math.min(from[0], to[0]);
  const x2 = Math.max(from[0], to[0]);
  const li = pickLine(to[1], x1, x2, lines);
  if (li < 0) return { kind: 'path', points: [[from[0], from[1]], [to[0], to[1]]] };
  const line = lines[li];
  return { kind: 'line', y: line.y, x1, x2, text: lineText(line, x1, x2) };
}
