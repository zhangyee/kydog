import { describe, it, expect } from 'vitest';
import { parseImageBlockAlt, serializeImageBlockAlt } from './imageBlockAlt';

describe('parseImageBlockAlt', () => {
  it('Milkdown 自己写出的比例格式（toFixed(2)）当比例', () => {
    expect(parseImageBlockAlt('1.50')).toEqual({ ratio: 1.5, alt: '' });
    expect(parseImageBlockAlt('0.75')).toEqual({ ratio: 0.75, alt: '' });
    expect(parseImageBlockAlt('1.00')).toEqual({ ratio: 1, alt: '' });
  });

  it('其余一律是说明文字，原样保留（「2023」「图 3」不会被误读成比例）', () => {
    for (const alt of ['块级图', '2023', '图 3', '1.5', '1.500', ' 1.50', 'Fig. 2', '0.00']) {
      expect(parseImageBlockAlt(alt), alt).toEqual({ ratio: 1, alt });
    }
  });

  it('没有 alt → 比例 1、空说明', () => {
    expect(parseImageBlockAlt(undefined)).toEqual({ ratio: 1, alt: '' });
    expect(parseImageBlockAlt(null)).toEqual({ ratio: 1, alt: '' });
    expect(parseImageBlockAlt('')).toEqual({ ratio: 1, alt: '' });
  });
});

describe('serializeImageBlockAlt', () => {
  it('有说明文字 → 写说明文字（哪怕拖过缩放：说明是内容，比例是外观）', () => {
    expect(serializeImageBlockAlt({ ratio: 1, alt: '块级图' })).toBe('块级图');
    expect(serializeImageBlockAlt({ ratio: 1.5, alt: '块级图' })).toBe('块级图');
  });

  it('没有说明文字：比例 ≠ 1 写比例，= 1 写空', () => {
    expect(serializeImageBlockAlt({ ratio: 1.5, alt: '' })).toBe('1.50');
    expect(serializeImageBlockAlt({ ratio: 1, alt: '' })).toBe('');
    expect(serializeImageBlockAlt({ ratio: Number.NaN, alt: '' })).toBe('');
  });

  it('读写往返：说明文字与比例各自稳定', () => {
    for (const alt of ['块级图', '2023', '1.50', '0.00', '']) {
      expect(serializeImageBlockAlt(parseImageBlockAlt(alt)), alt).toBe(alt === '1.00' ? '' : alt);
    }
  });
});
