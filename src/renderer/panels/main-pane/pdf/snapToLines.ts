import type { HighlightSegment } from '../../../../shared/pdfSidecar';
import type { TextLine } from './textLines';

export type Point = [number, number];

const SNAP_MARGIN = 4;  // 行上下沿向外扩这么多仍算落在行上
const MIN_LENGTH = 4;   // 整笔总长小于此丢弃

function nearestLine(p: Point, lines: TextLine[]): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (p[1] < l.top - SNAP_MARGIN || p[1] > l.bottom + SNAP_MARGIN) continue;
    const d = Math.abs(p[1] - l.y);
    if (d < bestD) { bestD = d; best = i; }
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
 * 采样点 → 段：连续落在同一文本行的点归一段 `line`（y 取行中线，x 取最左最右），
 * 不在任何行上的连续点归一段 `path`。返回空数组表示这笔该丢弃。
 */
export function snapToLines(points: Point[], lines: TextLine[]): HighlightSegment[] {
  if (points.length < 2 || pathLength(points) < MIN_LENGTH) return [];
  const segments: HighlightSegment[] = [];
  let runLine = -2;   // -2 尚未开始，-1 自由笔画，>= 0 行号
  let run: Point[] = [];
  const flush = () => {
    if (run.length === 0) return;
    if (runLine >= 0) {
      const line = lines[runLine];
      const xs = run.map((p) => p[0]);
      const x1 = Math.min(...xs);
      const x2 = Math.max(...xs);
      segments.push({ kind: 'line', y: line.y, x1, x2, text: lineText(line, x1, x2) });
    } else {
      segments.push({ kind: 'path', points: run.map((p) => [p[0], p[1]]) });
    }
    run = [];
  };
  for (const p of points) {
    const li = nearestLine(p, lines);
    if (li !== runLine) { flush(); runLine = li; }
    run.push(p);
  }
  flush();
  return segments;
}
