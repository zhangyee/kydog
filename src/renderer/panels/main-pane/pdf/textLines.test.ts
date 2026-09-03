import { describe, it, expect } from 'vitest';
import { textLines, type TextItemLike } from './textLines';

// 400 高的页、无旋转：视口 y = 400 − PDF y
const viewport = { convertToViewportPoint: (x: number, y: number): [number, number] => [x, 400 - y] };

function item(str: string, x: number, baseline: number, width: number, hasEOL = false, height = 14): TextItemLike {
  return { str, transform: [14, 0, 0, 14, x, baseline], width, height, hasEOL };
}

describe('textLines', () => {
  it('同一行两个项归一行，中线与上下沿按字高算', () => {
    const lines = textLines([item('Cited ', 40, 340, 40), item('passage', 80, 340, 60, true)], viewport);
    expect(lines).toHaveLength(1);
    expect(lines[0].top).toBeCloseTo(46);      // 400 − (340 + 14)
    expect(lines[0].bottom).toBeCloseTo(60);   // 400 − 340
    expect(lines[0].y).toBeCloseTo(53);
    expect(lines[0].items).toEqual([{ x1: 40, x2: 80, str: 'Cited ' }, { x1: 80, x2: 140, str: 'passage' }]);
  });

  it('hasEOL 断行', () => {
    const lines = textLines([item('a', 40, 340, 10, true), item('b', 40, 300, 10, true)], viewport);
    expect(lines.map((l) => l.items[0].str)).toEqual(['a', 'b']);
    expect(lines[1].y).toBeCloseTo(93);
  });

  it('行内项按 x 排序', () => {
    const lines = textLines([item('second', 100, 340, 50), item('first', 40, 340, 50, true)], viewport);
    expect(lines[0].items.map((i) => i.str)).toEqual(['first', 'second']);
  });

  it('空字符串的 EOL 标记项只断行不成项', () => {
    const lines = textLines([item('a', 40, 340, 10), item('', 50, 340, 0, true), item('b', 40, 300, 10, true)], viewport);
    expect(lines).toHaveLength(2);
    expect(lines[0].items).toEqual([{ x1: 40, x2: 50, str: 'a' }]);
  });

  it('最后一行没有 hasEOL 也收进来', () => {
    expect(textLines([item('tail', 40, 300, 30)], viewport)).toHaveLength(1);
  });

  it('空输入返回空表', () => {
    expect(textLines([], viewport)).toEqual([]);
  });
});
