// pdf.js getTextContent 的文本项 → 按行归并（spec §6.3）。
// 项的 transform[4] / [5] 是基线起点（PDF 用户坐标，y 向上），width / height 是宽与字高；
// 坐标一律交给 viewport.convertToViewportPoint 换算，不手算（MediaBox 原点、/Rotate 都由它处理）。

import type { PlaceholderScript } from '../../../../shared/zhSidecar';

export type TextItemLike = { str: string; transform: number[]; width: number; height: number; hasEOL: boolean; fontName?: string };
export type ViewportLike = { convertToViewportPoint(x: number, y: number): number[] };
export type LineItem = { x1: number; x2: number; str: string; script?: PlaceholderScript };
export type FontStyles = Record<string, { ascent: number; descent: number }>;
export type TextLine = { y: number; top: number; bottom: number; items: LineItem[]; inkTop?: number; inkBottom?: number };

/**
 * `styles` 是 pdf.js `getTextContent().styles`：每种字体的 ascent / descent（em 比例，descent 为负）。
 * 有它就顺带算出每行的**墨迹**顶 / 底——字身框（基线 → 基线 + 字高）不含基线以下的降部，
 * 盖子按字身框画会漏出 g / p / y 的尖（spec 2026-09-07 §0.1）。`top / bottom / y` 一律不变：
 * 它们同时供高亮吸附使用。查不到字体的项按字身框参与并集；整行一个都查不到就不给 ink 字段。
 */
export function textLines(items: TextItemLike[], viewport: ViewportLike, styles?: FontStyles): TextLine[] {
  const lines: TextLine[] = [];
  let cur: { top: number; bottom: number; items: LineItem[]; inkTop: number; inkBottom: number; anyInk: boolean } | null = null;
  /**
   * 本行最近一个非脚标项（spec 2026-09-07 scripts §2.1）。脚标 = height 比它小且基线偏移不为零；
   * 偏移沿**基字**的向上向量量（旋转项与 §8.1 同一套向量写法）。height === 0 的项（pdf.js 插的假空格，
   * 继承前一项的基线）既不当基字也不当脚标。换行归零。
   */
  let base: { height: number; e: number; f: number; ux: number; uy: number } | null = null;
  const flush = () => {
    if (!cur) return;
    cur.items.sort((a, b) => a.x1 - b.x1);
    // y 取「基线上方四分之一个字高」，不是字身框的正中。
    // 字身框是 [基线, 基线 + 字高]，正中落在半个字高处 —— 那是大写字母的腰部，比人眼看到的
    // 「这行字的中间」高出一截：小写字母只到 x 高（≈ 0.5 字高），还有 g/y 的降部伸到基线以下。
    // 拿正中当中线，高亮就整体偏上、盖住行上方的空白而露出字的下半（用户实测的偏移）。
    // 四分之一处约等于 x 高的中点，正是记号笔该压的位置。
    const emHeight = cur.bottom - cur.top;
    const line: TextLine = { y: cur.bottom - emHeight / 4, top: cur.top, bottom: cur.bottom, items: cur.items };
    if (cur.anyInk) { line.inkTop = cur.inkTop; line.inkBottom = cur.inkBottom; }
    lines.push(line);
    cur = null;
    base = null;
  };
  for (const it of items) {
    if (it.str.length > 0) {
      // 项的框从它自己的 transform 推，不假设“水平”：[a, b, c, d, e, f] 里 (a, b) 是前进方向、
      // (c, d) 是向上方向（都可能不是坐标轴方向——旋转 90°/270° 的项前进方向是 ±y）。四角
      // = 基线原点 + 前进 × {0, width} + 向上 × {0, height}，各自过 convertToViewportPoint 再取
      // min/max。水平文字下前进 = (1,0)、向上 = (0,1)，四角的 min/max 与老的对角两点写法逐位相同
      // （spec 2026-09-07 §8.1）。
      const [a, b, c, d, e, f] = it.transform;
      const sa = Math.hypot(a, b) || 1;
      const su = Math.hypot(c, d) || 1;
      const adv: [number, number] = [a / sa, b / sa];
      const up: [number, number] = [c / su, d / su];
      const at = (along: number, rise: number): [number, number] => {
        const [x, y] = viewport.convertToViewportPoint(e + adv[0] * along + up[0] * rise, f + adv[1] * along + up[1] * rise);
        return [x, y];
      };
      const box = [at(0, 0), at(it.width, 0), at(0, it.height), at(it.width, it.height)];
      const xs = box.map((p) => p[0]);
      const ys = box.map((p) => p[1]);
      const x1 = Math.min(...xs), x2 = Math.max(...xs);
      const top = Math.min(...ys), bottom = Math.max(...ys);
      const st = it.fontName !== undefined ? styles?.[it.fontName] : undefined;
      let inkTop = top, inkBottom = bottom;
      if (st) {
        // 墨迹框：把“向上”那一项换成 descent/ascent × height（descent 为负，落在基线下方）。
        const inkBox = [at(0, st.descent * it.height), at(it.width, st.descent * it.height), at(0, st.ascent * it.height), at(it.width, st.ascent * it.height)];
        const inkYs = inkBox.map((p) => p[1]);
        inkTop = Math.min(...inkYs);
        inkBottom = Math.max(...inkYs);
      }
      if (!cur) cur = { top, bottom, items: [], inkTop, inkBottom, anyInk: !!st };
      else {
        cur.top = Math.min(cur.top, top); cur.bottom = Math.max(cur.bottom, bottom);
        cur.inkTop = Math.min(cur.inkTop, inkTop); cur.inkBottom = Math.max(cur.inkBottom, inkBottom);
        cur.anyInk = cur.anyInk || !!st;
      }
      // 脚标判定。1e-3 pt 取整是**浮点相等**的处理，不是阈值：2512.03413 第 7 页 ❸ 与后文在内容流里
      // 同一基线，pdf.js 矩阵乘出来差 4e-14 pt；真实脚标的偏移 ≥ 0.147 倍基字字号（spec §2.2）。
      let script: PlaceholderScript | undefined;
      if (it.height > 0) {
        if (base && it.height < base.height) {
          const off = (e - base.e) * base.ux + (f - base.f) * base.uy;
          if (Math.round(off * 1000) !== 0) script = off < 0 ? 'sub' : 'sup';
        }
        if (script === undefined) base = { height: it.height, e, f, ux: up[0], uy: up[1] };
      }
      const li: LineItem = { x1, x2, str: it.str };
      if (script) li.script = script;
      cur.items.push(li);
    }
    if (it.hasEOL) flush();
  }
  flush();
  return lines;
}
