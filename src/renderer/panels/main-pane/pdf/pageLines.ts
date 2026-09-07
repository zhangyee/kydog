import type { PageLine } from '../../../../shared/zhSidecar';
import type { TextLine } from './textLines';

/**
 * `textLines` 的产出 → 翻译 RPC 的载荷（spec §4）。
 *
 * 行号是**内容流顺序**，不是阅读顺序，所以这里绝不排序——排了之后模型收到的顺序与我们记录的
 * 顺序就对不上了，而顺序是协议字段（spec §5：source 按模型给出的顺序拼）。
 *
 * `size` 取 `bottom - top`，也就是字身框的高。`textLines` 的 top/bottom 是该行所有 item 的并集,
 * 所以有上标的行会略高——组的 fontSize 取中位数（buildBlocks）正是为了不被这种行带偏。
 *
 * `textLines.ts` 一行都不用改：它已经给出 top / bottom 与按 x 排好序的 items。
 */
export function pageLines(lines: TextLine[]): PageLine[] {
  const out: PageLine[] = [];
  for (const l of lines) {
    if (l.items.length === 0) continue;       // 没有 item 的行没有几何可言，也没有文本可翻
    const x = l.items[0].x1;
    const x2 = l.items[l.items.length - 1].x2;
    const line: PageLine = {
      n: out.length + 1,
      x, y: l.top, w: x2 - x, h: l.bottom - l.top,
      size: l.bottom - l.top,
      text: l.items.map((i) => i.str).join(''),
    };
    if (l.inkTop !== undefined && l.inkBottom !== undefined) { line.inkTop = l.inkTop; line.inkBottom = l.inkBottom; }
    out.push(line);
  }
  return out;
}
