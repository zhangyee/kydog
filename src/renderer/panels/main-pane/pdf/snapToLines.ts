import type { HighlightSegment } from '../../../../shared/pdfSidecar';
import type { TextLine } from './textLines';

export type Point = [number, number];

const SNAP_MARGIN = 4;    // 判「这一笔算不算落在文字上」：行上下沿向外扩这么多
const STRAY_MARGIN = 12;  // 判「这个点归哪一行」：宽松一档，手抖出框不该把一笔切碎
const MIN_LENGTH = 4;     // 整笔总长小于此丢弃

/**
 * 距 p 最近的文本行；超出该行「半个行高 + margin」的够不着，返回 -1。
 * 用行高而不是固定值，标题行与正文行才各有合适的吸附范围。
 */
function nearestLine(p: Point, lines: TextLine[], margin: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const d = Math.abs(p[1] - l.y);
    if (d > (l.bottom - l.top) / 2 + margin || d >= bestD) continue;
    best = i;
    bestD = d;
  }
  return best;
}

function pathLength(points: Point[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    n += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return n;
}

/** 该行上与 [x1, x2] 横向有交集的项，按阅读顺序拼接。 */
export function lineText(line: TextLine, x1: number, x2: number): string {
  return line.items.filter((it) => it.x2 >= x1 && it.x1 <= x2).map((it) => it.str).join('');
}

/**
 * 采样点 → 段（spec §6.3）。
 *
 * 只要有一个采样点落在行框内，整笔就按「文字笔画」处理：每个点归到最近的一行，**同一行的点合成一条直线**
 * （y 取行中线，x 取这一行上所有点的最左最右）。一笔划过 N 行就得 N 条直线，一行一条。
 *
 * 早先按「连续同行的点归一段」分组，手抖出框的那一瞬会切出一个自由笔画段、再切回来，于是一笔在同一行上
 * 碎成好几截、中间留白（用户反馈 2）。碎不碎取决于手抖，那是把落盘结果交给了噪声；改成按行归并之后，
 * 「一行一条」是行表给出的事实，与采样抖动无关。
 *
 * 一个点也没落在文字上（划在图表、公式、页边）才是自由笔画，整笔原样保留。
 * 返回空数组表示这笔该丢弃（点太少或太短）。
 */
export function snapToLines(points: Point[], lines: TextLine[]): HighlightSegment[] {
  if (points.length < 2 || pathLength(points) < MIN_LENGTH) return [];
  if (!points.some((p) => nearestLine(p, lines, SNAP_MARGIN) >= 0)) {
    return [{ kind: 'path', points: points.map((p) => [p[0], p[1]]) }];
  }
  const spans = new Map<number, { x1: number; x2: number }>();
  const order: number[] = [];
  for (const p of points) {
    const li = nearestLine(p, lines, STRAY_MARGIN);
    if (li < 0) continue;   // 离任何行都太远（划到图上或页边）：这一段不落墨
    const cur = spans.get(li);
    if (!cur) { spans.set(li, { x1: p[0], x2: p[0] }); order.push(li); }
    else { cur.x1 = Math.min(cur.x1, p[0]); cur.x2 = Math.max(cur.x2, p[0]); }
  }
  return order.map((li) => {
    const { x1, x2 } = spans.get(li)!;
    const line = lines[li];
    return { kind: 'line', y: line.y, x1, x2, text: lineText(line, x1, x2) };
  });
}
