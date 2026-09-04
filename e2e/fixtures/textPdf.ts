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
 * 页数与页尺寸都可给的多页 PDF，每页只写一行页码——虚拟化用例要的是「页够多、页够大」，
 * 不需要文本几何精度（那是 buildTextPdf 的活）。对象编号：1 Catalog、2 Pages、3 Font，
 * 4 起是 count 个页对象，再往后是它们各自的内容流。
 *
 * `extra`：每页额外画一行文本（视口坐标，y 向下，函数内部换算成 PDF 的 y 向上）。
 * 可选、不传就是原来的行为——57 用它在「有 target 的译文块」矩形里放一点真实原文墨迹，
 * 好让「右格有没有把它盖掉」这条断言真的能测出东西；不传时 56 的既有用例不受影响。
 *
 * `bg`：每页先铺一层整页纯色底（RGB，0–255），可选、不传就是原来「无填色 = 白底」的行为。
 * 57 的对比度 e2e 用它造深色页——`pageBackground()` 是对页角 + 四边中点八点取样、全同才采用，
 * 整页纯色填充天然满足这一点，不需要另起一套画法。
 */
export function buildPagedPdf(
  count: number, w: number, h: number,
  extra?: { x: number; y: number; text: string; size?: number },
  bg?: [number, number, number],
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
    content += `BT /F1 24 Tf 40 ${h - 60} Td (Page ${i + 1}) Tj ET\n`;
    if (extra) content += `BT /F1 ${extra.size ?? 14} Tf ${extra.x} ${h - extra.y} Td (${extra.text}) Tj ET\n`;
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
