import { describe, it, expect } from 'vitest';
import { printOptionsFor, FOOTER_TEMPLATE } from './printOptions';

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

  it('页脚是居中的「— 页码 —」，不开书签（spec §1.12）', () => {
    expect(FOOTER_TEMPLATE).toContain('— <span class="pageNumber"></span> —');
    expect(FOOTER_TEMPLATE).toContain('text-align:center');
    // 正向：上面第一条已证明 toEqual 能抓到多出来的键；这里再点名书签两项不在
    const o = printOptionsFor({ paper: 'a4', margin: 'standard', pageNumbers: true }) as Record<string, unknown>;
    expect(o.generateDocumentOutline).toBeUndefined();
    expect(o.generateTaggedPDF).toBeUndefined();
  });
});
