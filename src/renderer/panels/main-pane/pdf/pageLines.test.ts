import { describe, it, expect } from 'vitest';
import type { TextLine } from './textLines';
import { pageLines } from './pageLines';

const L = (top: number, bottom: number, items: [number, number, string][]): TextLine =>
  ({ y: 0, top, bottom, items: items.map(([x1, x2, str]) => ({ x1, x2, str })) });

describe('pageLines', () => {
  it('行号从 1 起，几何取自 top/bottom 与首尾 item 的 x', () => {
    const out = pageLines([L(90, 102, [[72, 200, 'Deep learning'], [204, 300, ' has shown']])]);
    expect(out).toEqual([{ n: 1, x: 72, y: 90, w: 228, h: 12, size: 12, text: 'Deep learning has shown' }]);
  });
  it('多行按输入顺序编号，不排序', () => {
    const out = pageLines([L(200, 210, [[72, 100, 'b']]), L(90, 100, [[72, 100, 'a']])]);
    expect(out.map((l) => [l.n, l.text, l.y])).toEqual([[1, 'b', 200], [2, 'a', 90]]);
  });
  it('空行（没有 item）被丢掉，编号仍连续', () => {
    const out = pageLines([L(90, 100, [[72, 100, 'a']]), L(110, 120, []), L(130, 140, [[72, 100, 'c']])]);
    expect(out.map((l) => [l.n, l.text])).toEqual([[1, 'a'], [2, 'c']]);
  });
});
