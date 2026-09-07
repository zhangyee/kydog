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

describe('旋转项的框从 transform 自己的前进 / 向上方向推（spec 2026-09-07 §8.1）', () => {
  it('旋转 90° 的项（竖排 arXiv 印章）：框沿基线方向竖着走，不再横穿页面', () => {
    // 2512.03413.pdf 第 1 页行 86 的真实数据：transform [0, 20, −20, 0, 32, 229.36]、width 333.3、height 20，
    // 视口 [x, 792 − y]。按水平算会得到 x 32–365 × y 542–562 的横带；真实的框是 x 12–32 × y 229–563。
    const vp = { convertToViewportPoint: (x: number, y: number): [number, number] => [x, 792 - y] };
    const it: TextItemLike = { str: 'arXiv:2512.03413v1', transform: [0, 20, -20, 0, 32, 229.36], width: 333.3, height: 20, hasEOL: true, fontName: 'f1' };
    const [l] = textLines([it], vp, { f1: { ascent: 0.683, descent: -0.217 } });
    expect(l.items[0].x1).toBeCloseTo(12, 6);
    expect(l.items[0].x2).toBeCloseTo(32, 6);
    expect(l.top).toBeCloseTo(792 - (229.36 + 333.3), 6);
    expect(l.bottom).toBeCloseTo(792 - 229.36, 6);
    // 墨迹框在竖排下是 x 方向的收窄，纵向与字身框一致（降部伸向 −x）
    expect(l.inkTop).toBeCloseTo(l.top, 6);
    expect(l.inkBottom).toBeCloseTo(l.bottom, 6);
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

describe('脚标：比本行最近的基字更小且基线不同（spec 2026-09-07 scripts §2.1–2.2）', () => {
  // item(str, x, baseline, width, hasEOL, height)
  it('(a) 更小 + 更低 → sub；之后的全字号项成为新基字', () => {
    const [l] = textLines([item('node n', 40, 340, 30, false, 10), item('i', 70, 337.5, 3, false, 7), item(' from', 73, 340, 20, true, 10)], viewport);
    expect(l.items.map((i) => i.script ?? '')).toEqual(['', 'sub', '']);
  });
  it('(b) 更小 + 更高 → sup', () => {
    const [l] = textLines([item('CO', 40, 300, 12, false, 10), item('2', 52, 303.3, 3, true, 7)], viewport);
    expect(l.items[1].script).toBe('sup');
  });
  it('(c) 同高 + 基线不同 → 不是脚标（Word 式同字号脚注号退化成平排）', () => {
    const [l] = textLines([item('foot', 40, 260, 20, false, 10), item('1', 60, 263.3, 3, true, 10)], viewport);
    expect(l.items.map((i) => i.script)).toEqual([undefined, undefined]);
  });
  it('(d) 更小 + 同基线 → 不是脚标（题注里 9pt 标签接 8pt 正文）', () => {
    const [l] = textLines([item('Figure 1.', 40, 300, 30, false, 9), item(' A caption', 70, 300, 40, true, 8)], viewport);
    expect(l.items.map((i) => i.script)).toEqual([undefined, undefined]);
  });
  it('(e) 基线只差浮点尾差（❸ 行：302.479 对 302.47900000000004）→ 不是脚标；去掉 1e-3 取整这条就红', () => {
    const [l] = textLines([item('❸', 40, 302.47900000000004, 8, false, 10.9), item('Reasoner.', 50, 302.479, 40, true, 8.97)], viewport);
    expect(l.items[1].script).toBeUndefined();
  });
  it('(f) height = 0 的假空格既不当基字也不当脚标；之后的脚标仍相对真基字判', () => {
    const [l] = textLines([item('v', 40, 340, 5, false, 8), item(' ', 45, 338.8, 0, false, 0), item('n', 46, 338.8, 4, true, 6)], viewport);
    expect(l.items.map((i) => i.script ?? '')).toEqual(['', '', 'sub']);
  });
  it('(g) τ′ᵢ：′ 更高、𝑖 更低，都相对 τ 判 → 一 sup 一 sub', () => {
    const [l] = textLines([item('τ', 40, 340, 5, false, 9), item('′', 45, 343.3, 2, false, 6.6), item('i', 45, 337.5, 3, true, 6.6)], viewport);
    expect(l.items.map((i) => i.script ?? '')).toEqual(['', 'sup', 'sub']);
  });
  it('(i) 换行归零：下一行首项即使更小也是基字', () => {
    const lines = textLines([item('big', 40, 340, 20, true, 14), item('small', 40, 300, 20, true, 8)], viewport);
    expect(lines[1].items[0].script).toBeUndefined();
  });
  it('(j) 旋转 90° 的项沿基字的 up 向量判：偏移取 (e − e₀)·up₀', () => {
    // 前进 (0,1)、向上 (−1,0)：基线偏移落在 −x 方向。脚标 x 更小 → up 方向为正 → sup；x 更大 → sub。
    const rot = (str: string, e: number, f: number, h: number, hasEOL = false): TextItemLike =>
      ({ str, transform: [0, h, -h, 0, e, f], width: 20, height: h, hasEOL });
    const [a] = textLines([rot('base', 100, 300, 10), rot('s', 98, 320, 7, true)], viewport);
    expect(a.items.find((i) => i.str === 's')!.script).toBe('sup');
    const [b] = textLines([rot('base', 100, 300, 10), rot('s', 102, 320, 7, true)], viewport);
    expect(b.items.find((i) => i.str === 's')!.script).toBe('sub');
  });
});
