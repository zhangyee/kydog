import { describe, it, expect } from 'vitest';
import { straightSegment, lineText } from './straightenStroke';
import type { TextLine } from './textLines';

const L1: TextLine = { y: 53, top: 46, bottom: 60, items: [
  { x1: 40, x2: 100, str: 'Cited ' }, { x1: 100, x2: 180, str: 'passage' }, { x1: 180, x2: 240, str: ' conditioning' },
] };
const L2: TextLine = { y: 93, top: 86, bottom: 100, items: [{ x1: 40, x2: 220, str: 'reduces unsupported claims' }] };
const LINES = [L1, L2];

describe('straightSegment', () => {
  it('落在文字上：一条贴行中线的直线，x 取起点与当前点之间，text 只拼横向有交集的项', () => {
    expect(straightSegment([110, 55], [170, 51], LINES))
      .toEqual({ kind: 'line', y: 53, x1: 110, x2: 170, text: 'passage' });
  });

  it('从右往左划也是同一条：x1 / x2 按大小排，不按先后', () => {
    expect(straightSegment([170, 53], [110, 53], LINES))
      .toMatchObject({ x1: 110, x2: 170 });
  });

  it('贴哪一行看当前点：按住滑到下一行，整条就落到下一行', () => {
    expect(straightSegment([50, 53], [200, 92], LINES)).toMatchObject({ kind: 'line', y: 93, x1: 50, x2: 200 });
  });

  it('中途手抖不影响结果：一笔只由起点与当前点决定，恒定一段', () => {
    const a = straightSegment([50, 53], [200, 53], LINES);
    const b = straightSegment([50, 53], [200, 57], LINES);   // 终点飘了 4 单位
    expect(a).toEqual(b);
  });

  it('行与行之间的缝隙仍归最近的行，不会脱开成斜线', () => {
    expect(straightSegment([50, 53], [200, 70], LINES)).toMatchObject({ kind: 'line', y: 53 });
  });

  it('离所有行都远：起点到当前点的直连线段，任意角度', () => {
    expect(straightSegment([300, 500], [340, 560], []))
      .toEqual({ kind: 'path', points: [[300, 500], [340, 560]] });
    expect(straightSegment([300, 500], [340, 560], LINES))
      .toEqual({ kind: 'path', points: [[300, 500], [340, 560]] });
  });

  it('起点到当前点不足 4 单位：丢弃', () => {
    expect(straightSegment([50, 53], [52, 53], LINES)).toBeNull();
  });

  it('lineText 与 [x1, x2] 有交集的项按顺序拼接', () => {
    expect(lineText(L1, 90, 110)).toBe('Cited passage');
    expect(lineText(L1, 250, 300)).toBe('');
  });
});
