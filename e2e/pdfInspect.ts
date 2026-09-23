import { promises as fs } from 'node:fs';

/**
 * 用 pdfjs 读一份导出的 PDF（md 导出 PDF 的 e2e 用，spec 2026-09-22-md-export-pdf-design §5）：
 * 每页尺寸、文字片段（带坐标）与按基线拼好的行、画进页面的图片、链接注解；另给原始字节里的字体名。
 * 跑在 Playwright 的测试进程里（Node），不经过应用。
 */
export type PdfTextItem = { str: string; x: number; y: number; width: number };

export type PdfPage = {
  width: number;
  height: number;
  items: PdfTextItem[];
  /** 同一条基线上的片段按 x 从左到右直接相接。代码高亮把一行拆成很多段（const / line_1 / = …），
   *  行号来自 ::before 的生成内容、也是单独一段；不按行拼，`300 const LAST`、`— 2 —` 这类判据就对不上。 */
  lines: string[];
  /** 每一次 paintImageXObject 画的那张图：`width` / `height` 是嵌进去的像素尺寸（pdfjs 的算子参数是
   *  [objId, w, h]），`drawn` 是它画在页上的大小（pt）。
   *  记尺寸不只记次数：坏图时 Chromium 可能画自己的占位图标，数次数分不出来。像素尺寸还是「图被裁了没有」
   *  的判据：图被 object-fit 裁掉一截时，Skia 只把看得见的那一截嵌进 PDF（2026-09-22 探针：1600×400 的图
   *  被裁成 1230×400）。`drawn` 是「图印得有多宽」的判据：图片 XObject 画在单位正方形里，当时的变换矩阵
   *  把它的两条边映成多长，页上就是多大。 */
  images: Array<{ width: number; height: number; drawn: { width: number; height: number } }>;
  /** 链接注解的目标。pdfjs 只把它认得的协议（http / https / mailto …）放进 `url`，file: 之类只留在
   *  `unsafeUrl`（2026-09-22 实测：Chromium 把 `<a href="other.md">` 印成 file:///…/other.md 的链接注解，
   *  pdfjs 读出来 url 是 undefined）—— 只收 `url` 的话，一条没被去掉的相对链接会悄悄漏网，
   *  「相对链接不留 href」那条否定断言就成了假绿。两个都收。 */
  links: string[];
};

type Matrix = [number, number, number, number, number, number];

/** 先施加 m、再施加 ctm（PDF 的 cm 与 canvas 的 transform() 都是右乘在当前矩阵上）。 */
function times(ctm: Matrix, m: Matrix): Matrix {
  const [a, b, c, d, e, f] = ctm;
  return [
    a * m[0] + c * m[1], b * m[0] + d * m[1],
    a * m[2] + c * m[3], b * m[2] + d * m[3],
    a * m[4] + c * m[5] + e, b * m[4] + d * m[5] + f,
  ];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 按基线把片段拼成行。键是 y 本身（保留两位小数只为吸收浮点噪声）：同一行的片段来自同一个行盒、
 * 基线是同一个数，这是 PDF 里「同一行」唯一的协议事实，不做就近归并 —— 归并的容差给大了会把相邻两行
 * 拼到一起，给小了等于没给。
 */
function linesOf(items: PdfTextItem[]): string[] {
  const rows = new Map<string, PdfTextItem[]>();
  for (const it of items) {
    const key = it.y.toFixed(2);
    rows.set(key, [...(rows.get(key) ?? []), it]);
  }
  return [...rows.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))   // PDF 坐标 y 向上：从页顶往下读
    .map(([, row]) => row.sort((a, b) => a.x - b.x).map((i) => i.str).join(''));
}

export type PdfReport = {
  pages: PdfPage[];
  /** 所有页的行按页序、行序用换行连起来。 */
  text: string;
  /** 所有页的行，按页序、行序。 */
  lines: string[];
  /** 嵌入字体的名字（去掉子集前缀 `ABCDEF+`）。 */
  fontNames: string[];
};

export async function inspectPdf(file: string): Promise<PdfReport> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = await fs.readFile(file);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const pages: PdfPage[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const view = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const it of content.items) {
        if (!('str' in it)) continue;   // TextMarkedContent：没有文字
        items.push({ str: it.str, x: it.transform[4] as number, y: it.transform[5] as number, width: it.width });
      }
      const ops = await page.getOperatorList();
      const images: PdfPage['images'] = [];
      // 跟着算子列表走一遍变换矩阵：save / restore 与 form XObject 的开始 / 结束成对进出栈，
      // 同 pdfjs 自己的 canvas 画法（CanvasGraphics 的 paintFormXObjectBegin / End）
      let ctm: Matrix = [1, 0, 0, 1, 0, 0];
      const stack: Matrix[] = [];
      ops.fnArray.forEach((fn, i) => {
        const args = ops.argsArray[i] as unknown[];
        if (fn === pdfjs.OPS.save) stack.push(ctm);
        else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === pdfjs.OPS.transform) ctm = times(ctm, args as Matrix);
        else if (fn === pdfjs.OPS.paintFormXObjectBegin) {
          stack.push(ctm);
          const m = args[0] as Matrix | null;
          if (m) ctm = times(ctm, m);
        } else if (fn === pdfjs.OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
        else if (fn === pdfjs.OPS.paintImageXObject) {
          const [, w, h] = args as [string, number, number];
          images.push({
            width: w, height: h,
            drawn: { width: round2(Math.hypot(ctm[0], ctm[1])), height: round2(Math.hypot(ctm[2], ctm[3])) },
          });
        }
      });
      const links: string[] = [];
      for (const a of (await page.getAnnotations()) as Array<{ subtype?: string; url?: string; unsafeUrl?: string }>) {
        if (a.subtype !== 'Link') continue;
        const target = a.url ?? a.unsafeUrl;
        if (typeof target === 'string') links.push(target);
      }
      pages.push({ width: view.width, height: view.height, items, lines: linesOf(items), images, links });
    }
  } finally {
    await doc.destroy();
  }
  // 字体名在 PDF 字典里是明文（Chromium/Skia 不压缩对象字典，2026-09-22 探针实测 pdffonts 与字节一致）
  const fontNames = [...new Set(
    [...bytes.toString('latin1').matchAll(/\/BaseFont\s*\/[A-Z]{6}\+([A-Za-z0-9_-]+)/g)].map((m) => m[1]),
  )];
  const lines = pages.flatMap((p) => p.lines);
  return { pages, text: lines.join('\n'), lines, fontNames };
}
