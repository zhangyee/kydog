import { describe, it, expect } from 'vitest';
import { buildTextPdf, buildTwoColumnPdf, TEXT_PDF_LINES, TWO_COL_LEFT, TWO_COL_RIGHT } from '../../../../../e2e/fixtures/textPdf';
import { textLines } from './textLines';

// 待实测 1 / 4（spec §10）：pdf.js 的 getTextContent 在这个 fixture 上给出
// str / transform / width / height / hasEOL，且行尾项 hasEOL 为 true。
describe('textLines 对着真 pdf.js', () => {
  it('fixture 有文本层，分成两行，行中线与预期一致', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buildTextPdf()) }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    // pdfjs-dist 不从包顶层导出 TextItem 类型名，从 getTextContent 的返回值结构里取，
    // 避免深径类型导入；Extract 用 str 字段把联合类型收窄到有文本的那一支。
    type ContentItem = Awaited<ReturnType<typeof page.getTextContent>>['items'][number];
    const items = content.items.filter((it): it is Extract<ContentItem, { str: string }> => typeof (it as { str?: unknown }).str === 'string');
    // 报告里贴这一行的输出（字段齐全即待实测 1 成立）
    console.log('pdfjs text items:', JSON.stringify(items.map((i) => ({ str: i.str, t: i.transform, w: i.width, h: i.height, eol: i.hasEOL }))));
    expect(items.length).toBeGreaterThan(0);
    const lines = textLines(items, page.getViewport({ scale: 1 }));
    expect(lines.map((l) => l.items.map((i) => i.str).join(''))).toEqual(TEXT_PDF_LINES);
    // 基线 340、字高 14 → 视口 top 46、bottom 60；y 取基线上方 1/4 字高 = 56.5
    expect(lines[0].y).toBeCloseTo(56.5, 0);
    expect(lines[1].y).toBeCloseTo(96.5, 0);
    expect(lines[0].items[0].x1).toBeCloseTo(40, 0);
    await doc.destroy();
  });
});

/**
 * 这一组不是「期望的行为」，是把实测到的边界钉成回归用例（翻译流水线 spec §0.2）。
 *
 * `textLines` 按 pdf.js 的返回顺序边走边切、遇 `hasEOL` 断行。同一份双栏版面，内容流按栏顺序发
 * 就得到 8 条独立行；同一基线先左后右地交错发，pdf.js 只在换基线处给 `hasEOL`，于是左右两栏被
 * 并进同一条「行」——**那之后无论怎么分组都救不回来，输入已经把两栏搅在一起了**。
 *
 * 77 篇真实论文（arXiv 与六家期刊）实测下来零例正文跨栏，所以翻译流水线维持「行是原子」的抽取
 * 契约。留这条用例是为了：哪天 pdf.js 改了 `hasEOL` 的判定，红的是这里，而不是让翻译在某一类
 * 文档上静默变差。真碰到交错的文档时，修法是在归行之后加一道按几何切分的后处理，放新模块，
 * 不动 textLines——它同时供标注的高亮吸附使用。
 */
describe('textLines 对内容流顺序的依赖（已知边界）', () => {
  async function linesOf(bytes: Buffer): Promise<string[]> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    type ContentItem = Awaited<ReturnType<typeof page.getTextContent>>['items'][number];
    const items = content.items.filter((it): it is Extract<ContentItem, { str: string }> => typeof (it as { str?: unknown }).str === 'string');
    const out = textLines(items, page.getViewport({ scale: 1 })).map((l) => l.items.map((i) => i.str).join(''));
    await doc.destroy();
    return out;
  }

  it('按栏顺序（真实生成器的做法）→ 左右各 4 行，互不相干', async () => {
    expect(await linesOf(buildTwoColumnPdf('columnwise'))).toEqual([...TWO_COL_LEFT, ...TWO_COL_RIGHT]);
  });

  it('交错 → 左右被并进同一行（当前行为，非期望行为）', async () => {
    const lines = await linesOf(buildTwoColumnPdf('interleaved'));
    expect(lines).toHaveLength(4);
    // pdf.js 会在两栏之间补一个合成空格项，所以断言「同一行里两栏都在」而不是逐字符相等
    lines.forEach((l, i) => {
      expect(l).toContain(TWO_COL_LEFT[i]);
      expect(l).toContain(TWO_COL_RIGHT[i]);
    });
  });
});
