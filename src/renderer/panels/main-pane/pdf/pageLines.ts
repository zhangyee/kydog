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
 */
export function pageLines(lines: TextLine[]): PageLine[] {
  const out: PageLine[] = [];
  for (const l of lines) {
    if (l.items.length === 0) continue;       // 没有 item 的行没有几何可言，也没有文本可翻
    const x = l.items[0].x1;
    const x2 = l.items[l.items.length - 1].x2;
    // 拼 text 的同时记下脚标区间：按 x 排序后**相邻**的同类脚标并成一段（"10⁻³" 的 − 与 3 是一个占位符）；
    // 中间隔着任何非脚标项（含 pdf.js 的假空格）就不并（spec 2026-09-07 scripts §2.3）。
    let text = '';
    const scripts: NonNullable<PageLine['scripts']> = [];
    for (const it of l.items) {
      const start = text.length;
      text += it.str;
      if (!it.script) continue;
      const last = scripts[scripts.length - 1];
      if (last && last.kind === it.script && last.end === start) last.end = text.length;
      else scripts.push({ start, end: text.length, kind: it.script });
    }
    const line: PageLine = {
      n: out.length + 1,
      x, y: l.top, w: x2 - x, h: l.bottom - l.top,
      size: l.bottom - l.top,
      text,
    };
    if (scripts.length) line.scripts = scripts;
    if (l.inkTop !== undefined && l.inkBottom !== undefined) { line.inkTop = l.inkTop; line.inkBottom = l.inkBottom; }
    out.push(line);
  }
  return out;
}
