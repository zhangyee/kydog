import { describe, it, expect } from 'vitest';
import { printOptionsFor, printableWidthPx, FOOTER_TEMPLATE } from './printOptions';

describe('printOptionsFor', () => {
  it('A4 / 标准 / 页码开', () => {
    expect(printOptionsFor({ paper: 'a4', margin: 'standard', pageNumbers: true })).toEqual({
      pageSize: 'A4',
      margins: { top: 1, bottom: 1, left: 1, right: 1 },
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: FOOTER_TEMPLATE,
    });
  });

  it('Letter / 窄 / 页码关：没有页眉页脚模板', () => {
    expect(printOptionsFor({ paper: 'letter', margin: 'narrow', pageNumbers: false })).toEqual({
      pageSize: 'Letter',
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      printBackground: true,
      displayHeaderFooter: false,
    });
  });

  it('三个维度各自独立（逐个翻面）', () => {
    expect(printOptionsFor({ paper: 'letter', margin: 'standard', pageNumbers: true }).pageSize).toBe('Letter');
    expect(printOptionsFor({ paper: 'a4', margin: 'narrow', pageNumbers: true }).margins).toEqual({ top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 });
    expect(printOptionsFor({ paper: 'a4', margin: 'standard', pageNumbers: false }).displayHeaderFooter).toBe(false);
  });

  it('页脚是居中的「— 页码 —」', () => {
    expect(FOOTER_TEMPLATE).toContain('— <span class="pageNumber"></span> —');
    expect(FOOTER_TEMPLATE).toContain('text-align:center');
  });

  it('不开书签（spec §1.12）：页码开 / 关两种的键集合逐个点名', () => {
    // 有的与没有的在同一个断言里：多出 generateDocumentOutline / generateTaggedPDF 会红，
    // 该有的键少了一个也会红 —— 不靠别的用例替它证明「这种读法抓得到多出来的键」
    expect(Object.keys(printOptionsFor({ paper: 'a4', margin: 'standard', pageNumbers: true })).sort())
      .toEqual(['displayHeaderFooter', 'footerTemplate', 'headerTemplate', 'margins', 'pageSize', 'printBackground']);
    expect(Object.keys(printOptionsFor({ paper: 'letter', margin: 'narrow', pageNumbers: false })).sort())
      .toEqual(['displayHeaderFooter', 'margins', 'pageSize', 'printBackground']);
  });
});

describe('printableWidthPx', () => {
  it('版心宽 = (纸宽 − 左右边距) × 96 CSS px/in，四种组合逐个钉数', () => {
    // A4 按 Electron 自己的纸张表是 8.27in：6.27 × 96 = 601.92 → 602；窄边距 7.27 × 96 = 697.92 → 698
    expect(printableWidthPx({ paper: 'a4', margin: 'standard', pageNumbers: true })).toBe(602);
    expect(printableWidthPx({ paper: 'letter', margin: 'standard', pageNumbers: true })).toBe(624);
    expect(printableWidthPx({ paper: 'a4', margin: 'narrow', pageNumbers: true })).toBe(698);
    expect(printableWidthPx({ paper: 'letter', margin: 'narrow', pageNumbers: true })).toBe(720);
  });

  it('页码开关不影响版心宽（页脚在下边距里）', () => {
    expect(printableWidthPx({ paper: 'a4', margin: 'standard', pageNumbers: false })).toBe(602);
    expect(printableWidthPx({ paper: 'letter', margin: 'narrow', pageNumbers: false })).toBe(720);
  });

  it('与 printOptionsFor 用的是同一个左右边距', () => {
    for (const paper of ['a4', 'letter'] as const) {
      for (const margin of ['standard', 'narrow'] as const) {
        const o = { paper, margin, pageNumbers: true };
        const { left, right } = printOptionsFor(o).margins as { left: number; right: number };
        const paperIn = paper === 'a4' ? 8.27 : 8.5;
        expect(printableWidthPx(o), `${paper}/${margin}`).toBe(Math.round((paperIn - left - right) * 96));
      }
    }
  });
});
