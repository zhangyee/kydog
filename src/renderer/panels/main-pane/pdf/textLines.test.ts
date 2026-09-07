import { describe, it, expect } from 'vitest';
import { textLines, type TextItemLike } from './textLines';

// 400 高的页、无旋转：视口 y = 400 − PDF y
const viewport = { convertToViewportPoint: (x: number, y: number): [number, number] => [x, 400 - y] };

function item(str: string, x: number, baseline: number, width: number, hasEOL = false, height = 14, fontName?: string): TextItemLike {
  return { str, transform: [14, 0, 0, 14, x, baseline], width, height, hasEOL, ...(fontName ? { fontName } : {}) };
}

describe('textLines', () => {
  it('同一行两个项归一行，中线与上下沿按字高算', () => {
    const lines = textLines([item('Cited ', 40, 340, 40), item('passage', 80, 340, 60, true)], viewport);
    expect(lines).toHaveLength(1);
    expect(lines[0].top).toBeCloseTo(46);      // 400 − (340 + 14)
    expect(lines[0].bottom).toBeCloseTo(60);   // 400 − 340
    expect(lines[0].y).toBeCloseTo(56.5);   // 基线上方 1/4 字高：60 − 14/4，不是字身框正中 53
    expect(lines[0].items).toEqual([{ x1: 40, x2: 80, str: 'Cited ' }, { x1: 80, x2: 140, str: 'passage' }]);
  });

  it('hasEOL 断行', () => {
    const lines = textLines([item('a', 40, 340, 10, true), item('b', 40, 300, 10, true)], viewport);
    expect(lines.map((l) => l.items[0].str)).toEqual(['a', 'b']);
    expect(lines[1].y).toBeCloseTo(96.5);
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

describe('墨迹顶 / 底（pdf.js styles 的 ascent / descent）', () => {
  // Helvetica 在 pdf.js 里 ascent 0.718、descent −0.207（实测，e2e fixture 同一字体）
  const styles = { f1: { ascent: 0.718, descent: -0.207 } };

  it('有 styles → inkTop = 基线 − ascent·字高、inkBottom = 基线 + |descent|·字高；top / bottom / y 不变', () => {
    const [l] = textLines([item('gypq', 40, 340, 40, true, 14, 'f1')], viewport, styles);
    expect(l.top).toBeCloseTo(46);       // 400 − (340 + 14)：字身框不变
    expect(l.bottom).toBeCloseTo(60);
    expect(l.y).toBeCloseTo(56.5);
    expect(l.inkTop).toBeCloseTo(60 - 0.718 * 14, 6);
    expect(l.inkBottom).toBeCloseTo(60 + 0.207 * 14, 6);
  });

  it('一行里两种字号 → 墨迹顶取最小、底取最大', () => {
    const [l] = textLines([item('a', 40, 340, 10, false, 10, 'f1'), item('B', 60, 340, 10, true, 14, 'f1')], viewport, styles);
    expect(l.inkTop).toBeCloseTo(60 - 0.718 * 14, 6);
    expect(l.inkBottom).toBeCloseTo(60 + 0.207 * 14, 6);
  });

  it('没有 styles、或该项的字体查不到 → 该项按字身框参与并集；整行都查不到时不给 ink 字段', () => {
    const [noStyles] = textLines([item('x', 40, 340, 10, true, 14, 'f1')], viewport);
    expect(noStyles.inkTop).toBeUndefined();
    expect(noStyles.inkBottom).toBeUndefined();
    const [mixed] = textLines([item('a', 40, 340, 10, false, 14, 'zz'), item('g', 60, 340, 10, true, 14, 'f1')], viewport, styles);
    expect(mixed.inkTop).toBeCloseTo(Math.min(46, 60 - 0.718 * 14), 6);   // zz 按字身框 46
    expect(mixed.inkBottom).toBeCloseTo(60 + 0.207 * 14, 6);
  });
});

describe('/Rotate 90 / 270：视口 y 只是 PDF x 的函数（回归 C-1）', () => {
  // rotation-90 的替身：viewport y 完全不看 PDF y，只看 PDF x（真实 pdf.js 在 90°/270° 就是这样）。
  const rot90 = { convertToViewportPoint: (x: number, y: number): [number, number] => [y, x] };
  const styles = { f1: { ascent: 0.718, descent: -0.207 } };

  it('墨迹高应与字身框高相等且 > 0——旧实现两点共用 bx，ty/dy 在这个视口下恒等，墨迹高塌成 0', () => {
    const [l] = textLines([item('gypq', 40, 340, 40, true, 14, 'f1')], rot90, styles);
    const emHeight = l.bottom - l.top;
    expect(emHeight).toBeGreaterThan(0);
    expect(l.inkBottom! - l.inkTop!).toBeCloseTo(emHeight, 6);
  });
});
