import { describe, it, expect } from 'vitest';
import { buildTextPdf, TEXT_PDF_LINES } from '../../../../../e2e/fixtures/textPdf';
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
    expect(lines[0].y).toBeCloseTo(53, 0);   // 基线 340、字高 14 → 视口 top 46、bottom 60
    expect(lines[1].y).toBeCloseTo(93, 0);
    expect(lines[0].items[0].x1).toBeCloseTo(40, 0);
    await doc.destroy();
  });
});
