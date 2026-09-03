import type { HighlightSegment } from '../../../../shared/pdfSidecar';
import type { TextLine } from './textLines';

export type Point = [number, number];

// 归行的宽容量（超出行上下沿这么多仍算这一行）。取得比行距还宽一点，行与行之间的缝隙也会归到最近的行：
// 按住横向拖动时手稍微飘一下，直线不会在缝里突然脱开变成斜线。
const SNAP_MARGIN = 12;
// 起点到终点短于此就当没画：一次误点不该在论文上留一条标注。
const MIN_LENGTH = 4;

/** 距 p 最近的文本行；超出该行「半个行高 + SNAP_MARGIN」的够不着，返回 -1。用行高而不是固定值，标题行与正文行各有合适的吸附范围。 */
function nearestLine(p: Point, lines: TextLine[]): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const d = Math.abs(p[1] - l.y);
    if (d > (l.bottom - l.top) / 2 + SNAP_MARGIN || d >= bestD) continue;
    best = i;
    bestD = d;
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
  const li = nearestLine(to, lines);
  if (li < 0) return { kind: 'path', points: [[from[0], from[1]], [to[0], to[1]]] };
  const line = lines[li];
  const x1 = Math.min(from[0], to[0]);
  const x2 = Math.max(from[0], to[0]);
  return { kind: 'line', y: line.y, x1, x2, text: lineText(line, x1, x2) };
}
