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

  it('带墨迹顶 / 底的行 → PageLine 带 inkTop / inkBottom；没有的行不带', () => {
    const out = pageLines([
      { y: 56.5, top: 46, bottom: 60, inkTop: 49.9, inkBottom: 62.9, items: [{ x1: 40, x2: 80, str: 'a' }] },
      { y: 96.5, top: 86, bottom: 100, items: [{ x1: 40, x2: 80, str: 'b' }] },
    ]);
    expect(out[0].inkTop).toBeCloseTo(49.9);
    expect(out[0].inkBottom).toBeCloseTo(62.9);
    expect('inkTop' in out[1]).toBe(false);
  });
});

describe('脚标区间（spec 2026-09-07 scripts §2.3）', () => {
  const T = (items: { x1: number; x2: number; str: string; script?: 'sub' | 'sup' }[]): TextLine => ({ y: 0, top: 90, bottom: 100, items });
  it('区间是 text 的 code unit 偏移；没有脚标的行不写字段', () => {
    const out = pageLines([
      T([{ x1: 0, x2: 30, str: 'node n' }, { x1: 30, x2: 33, str: 'i', script: 'sub' }, { x1: 33, x2: 60, str: ' from' }]),
      T([{ x1: 0, x2: 10, str: 'plain' }]),
    ]);
    expect(out[0].text).toBe('node ni from');
    expect(out[0].scripts).toEqual([{ start: 6, end: 7, kind: 'sub' }]);
    expect('scripts' in out[1]).toBe(false);
  });
  it('相邻同类脚标并成一个区间（10⁻³ 的 − 与 3）', () => {
    const [l] = pageLines([T([{ x1: 0, x2: 10, str: '10' }, { x1: 10, x2: 13, str: '−', script: 'sup' }, { x1: 13, x2: 16, str: '3', script: 'sup' }])]);
    expect(l.scripts).toEqual([{ start: 2, end: 4, kind: 'sup' }]);
  });
  it('相邻但不同类不并（τ′ᵢ）；中间隔着假空格也不并', () => {
    const [a] = pageLines([T([{ x1: 0, x2: 5, str: 'τ' }, { x1: 5, x2: 7, str: '′', script: 'sup' }, { x1: 5, x2: 8, str: 'i', script: 'sub' }])]);
    expect(a.scripts).toEqual([{ start: 1, end: 2, kind: 'sup' }, { start: 2, end: 3, kind: 'sub' }]);
    const [b] = pageLines([T([{ x1: 0, x2: 5, str: 'v' }, { x1: 5, x2: 7, str: '1', script: 'sub' }, { x1: 7, x2: 8, str: ' ' }, { x1: 8, x2: 10, str: '2', script: 'sub' }])]);
    expect(b.scripts).toEqual([{ start: 1, end: 2, kind: 'sub' }, { start: 3, end: 4, kind: 'sub' }]);
  });
});
