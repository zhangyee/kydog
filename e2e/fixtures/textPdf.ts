/**
 * 带文本层的最小单页 PDF：300 × 400 pt，Helvetica 14 pt 两行正文，基线分别在 y = 340 与 y = 300
 * （PDF 坐标，y 向上；换成 react-pdf scale 1 的视口坐标就是 y = 60 与 y = 100）。
 * 自带正确的 xref 与 /Length，pdf.js 不需要走 recovery。
 */
export const TEXT_PDF_LINES = ['Cited passage conditioning', 'reduces unsupported claims'];

export function buildTextPdf(): Buffer {
  const content =
    `BT /F1 14 Tf 40 340 Td (${TEXT_PDF_LINES[0]}) Tj ET\n` +
    `BT /F1 14 Tf 40 300 Td (${TEXT_PDF_LINES[1]}) Tj ET\n`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ];
  return assemble(objs);
}

/**
 * 四行脚标写法的单页 PDF（300 × 400，Helvetica 10 pt；translation-scripts spec §0.1 / §8）：
 *   1. 字号变小 + `Ts` 下移 → sub          3. 同字号只用 `Ts` 上升 → 不判（Word 式脚注号，spec §2.4）
 *   2. 字号变小 + `Ts` 上移 → sup          4. 同一基字先上标（′）后下标（i）
 * 脚标用 `Ts`（文本上升）而不是 `Td` 挪基线：`Td` 是相对**行首**的位移，会把脚标拉回行首与正文重叠。
 */
export const SCRIPT_PDF_LINES = ['For each node ni from the tree', 'mass of CO2 in total', 'foot1 note', "type t'i of node"];

export function buildScriptPdf(): Buffer {
  const content =
    'BT /F1 10 Tf 40 340 Td (For each node n) Tj /F1 7 Tf -1.5 Ts (i) Tj 0 Ts /F1 10 Tf ( from the tree) Tj ET\n' +
    'BT /F1 10 Tf 40 300 Td (mass of CO) Tj /F1 7 Tf 3.6 Ts (2) Tj 0 Ts /F1 10 Tf ( in total) Tj ET\n' +
    'BT /F1 10 Tf 40 260 Td (foot) Tj 3.6 Ts (1) Tj 0 Ts ( note) Tj ET\n' +
    "BT /F1 10 Tf 40 220 Td (type t) Tj /F1 7 Tf 3.6 Ts (') Tj -1.5 Ts (i) Tj 0 Ts /F1 10 Tf ( of node) Tj ET\n";
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ];
  return assemble(objs);
}

/**
 * 页数与页尺寸都可给的多页 PDF，每页只写一行页码——虚拟化用例要的是「页够多、页够大」，
 * 不需要文本几何精度（那是 buildTextPdf 的活）。对象编号：1 Catalog、2 Pages、3 Font，
 * 4 起是 count 个页对象，再往后是它们各自的内容流。
 *
 * `extra`：每页额外画一行文本（视口坐标，y 向下，函数内部换算成 PDF 的 y 向上），单条或数组都行。
 * 可选、不传就是原来的行为——57 用它在「有 target 的译文块」矩形里放一点真实原文墨迹，
 * 好让「右格有没有把它盖掉」这条断言真的能测出东西；不传时 56 的既有用例不受影响。
 *
 * `bg`：每页先铺一层整页纯色底（RGB，0–255），可选、不传就是原来「无填色 = 白底」的行为。
 * 57 的对比度 e2e 用它造深色页——`pageBackground()` 是对页角 + 四边中点八点取样、全同才采用，
 * 整页纯色填充天然满足这一点，不需要另起一套画法。
 *
 * `patch`：在页面上再压一个纯色小矩形（视口坐标，y 向下）。57 用它把左上角那个采样点染成
 * 与其余七点不同的颜色，造出「八点取样取不到统一背景色」这条兜底路径——真实世界里落进这条
 * 路径的是扫描件与四边压着出血图的页，用一个角上的色块是最小的等价触发。
 */
type Extra = { x: number; y: number; text: string; size?: number };

export function buildPagedPdf(
  count: number, w: number, h: number,
  extra?: Extra | Extra[],
  bg?: [number, number, number],
  patch?: { x: number; y: number; w: number; h: number; color: [number, number, number] },
): Buffer {
  const firstPage = 4;
  const firstContent = firstPage + count;
  const kids = Array.from({ length: count }, (_, i) => `${firstPage + i} 0 R`).join(' ');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (let i = 0; i < count; i++) {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] `
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${firstContent + i} 0 R >>`,
    );
  }
  for (let i = 0; i < count; i++) {
    let content = '';
    if (bg) {
      const [r, g, b] = bg.map((v) => v / 255);
      content += `${r} ${g} ${b} rg 0 0 ${w} ${h} re f\n`;
    }
    if (patch) {
      const [r, g, b] = patch.color.map((v) => v / 255);
      // 视口坐标（y 向下）换成 PDF 坐标（y 向上）：矩形底边在 h - (patch.y + patch.h)
      content += `${r} ${g} ${b} rg ${patch.x} ${h - patch.y - patch.h} ${patch.w} ${patch.h} re f\n`;
    }
    content += `BT /F1 24 Tf 40 ${h - 60} Td (Page ${i + 1}) Tj ET\n`;
    for (const e of Array.isArray(extra) ? extra : extra ? [extra] : []) {
      content += `BT /F1 ${e.size ?? 14} Tf ${e.x} ${h - e.y} Td (${e.text}) Tj ET\n`;
    }
    objs.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  }
  return assemble(objs);
}

/**
 * **没有文本层**的多页 PDF：每页只画一个灰色矩形，内容流里一个 `BT ... ET` 都没有，
 * 也不带 /Font 资源——`getTextContent()` 因此返回空 items，翻译流水线的抽取阶段每页拿到零行，
 * 走「这份 PDF 没有文本层（可能是扫描件）」那条中止路径（translateDoc 的 `work.length === 0`）。
 *
 * 为什么不复用 `buildPagedPdf`：它每页无条件写一行页码（那正是虚拟化用例要的），改成可关会让
 * 那个"每页都有一行字"的前提变成可选，四个既有 spec 都得跟着重读一遍。真正的扫描件之所以没有
 * 文本层，正是因为整份内容流里只有图形算子——这里画一个矩形是最小的等价物（页面不是全白，
 * 「渲染确实发生过」与「抽不出文字」两件事因此能分开验）。
 */
export function buildNoTextPdf(count: number, w: number, h: number): Buffer {
  const firstPage = 3;
  const firstContent = firstPage + count;
  const kids = Array.from({ length: count }, (_, i) => `${firstPage + i} 0 R`).join(' ');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
  ];
  for (let i = 0; i < count; i++) {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] `
      + `/Resources << >> /Contents ${firstContent + i} 0 R >>`,
    );
  }
  for (let i = 0; i < count; i++) {
    const content = `0.6 0.6 0.6 rg 40 ${h - 220} ${w - 80} 160 re f\n`;
    objs.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`);
  }
  return assemble(objs);
}

/** objs[i] 是对象 i+1 的正文；补上头、xref 与 trailer。自带正确偏移，pdf.js 不用走 recovery。 */
function assemble(objs: string[]): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * 双栏 PDF，同一份版面用两种内容流顺序生成——这是 `textLines` 那条已知边界的最小复现件
 * （spec `2026-09-05-pdf-translation-pipeline-design.md` §0.2 / §4 末尾）。
 *
 * `order: 'columnwise'`：整条左栏走完再走右栏。实测的真实生成器（LaTeX、以及 Nature / PLOS /
 * Frontiers / Elsevier / IEEE / IOP 的排版链）都是这么发文本的。
 * `order: 'interleaved'`：同一基线先左后右，再下一基线。合法的 PDF，但 pdf.js 只在换基线处给
 * `hasEOL`，于是 `textLines` 会把左右两栏并进同一条「行」。
 *
 * 两栏的 x 分别是 72 与 320，四条基线 700 / 686 / 672 / 658，A4 尺寸（612 × 792）。
 */
export const TWO_COL_LEFT = ['Left line one here', 'Left line two here', 'Left line three ok', 'Left line four ok'];
export const TWO_COL_RIGHT = ['Right line one xx', 'Right line two xx', 'Right line three x', 'Right line four xx'];

export function buildTwoColumnPdf(order: 'columnwise' | 'interleaved'): Buffer {
  const ys = [700, 686, 672, 658];
  const draw = (x: number, y: number, s: string) => `BT /F1 10 Tf ${x} ${y} Td (${s}) Tj ET\n`;
  const content = order === 'columnwise'
    ? ys.map((y, i) => draw(72, y, TWO_COL_LEFT[i])).join('') + ys.map((y, i) => draw(320, y, TWO_COL_RIGHT[i])).join('')
    : ys.map((y, i) => draw(72, y, TWO_COL_LEFT[i]) + draw(320, y, TWO_COL_RIGHT[i])).join('');
  return assemble([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ]);
}
