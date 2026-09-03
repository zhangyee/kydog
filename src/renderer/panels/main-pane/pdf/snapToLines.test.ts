import { describe, it, expect } from 'vitest';
import { snapToLines, lineText } from './snapToLines';
import type { TextLine } from './textLines';

const L1: TextLine = { y: 53, top: 46, bottom: 60, items: [
  { x1: 40, x2: 100, str: 'Cited ' }, { x1: 100, x2: 180, str: 'passage' }, { x1: 180, x2: 240, str: ' conditioning' },
] };
const L2: TextLine = { y: 93, top: 86, bottom: 100, items: [{ x1: 40, x2: 220, str: 'reduces unsupported claims' }] };
const LINES = [L1, L2];

describe('snapToLines', () => {
  it('落在一行上：拉直到行中线，x 取最左最右，text 只拼横向有交集的项', () => {
    const segs = snapToLines([[110, 55], [140, 52], [170, 56]], LINES);
    expect(segs).toEqual([{ kind: 'line', y: 53, x1: 110, x2: 170, text: 'passage' }]);
  });

  it('斜跨两行拆成两段，顺序跟采样顺序', () => {
    const segs = snapToLines([[50, 52], [120, 56], [160, 90], [200, 94]], LINES);
    expect(segs.map((s) => s.kind)).toEqual(['line', 'line']);
    expect(segs[0]).toMatchObject({ y: 53, x1: 50, x2: 120 });
    expect(segs[1]).toMatchObject({ y: 93, x1: 160, x2: 200 });
  });

  it('上下沿外 4 单位以内仍算这一行，再远就是自由笔画', () => {
    expect(snapToLines([[50, 63], [120, 63]], LINES)[0].kind).toBe('line');   // bottom 60 + 3
    expect(snapToLines([[50, 66], [120, 66]], LINES)[0].kind).toBe('path');   // bottom 60 + 6
  });

  it('没有文本行：整笔是一个 path 段，点原样保留', () => {
    const pts: [number, number][] = [[300, 500], [310, 505], [330, 502]];
    expect(snapToLines(pts, [])).toEqual([{ kind: 'path', points: pts }]);
  });

  it('先在行上再划到图上：line 段后跟 path 段', () => {
    const segs = snapToLines([[50, 53], [120, 53], [130, 300], [160, 310]], LINES);
    expect(segs.map((s) => s.kind)).toEqual(['line', 'path']);
  });

  it('不足 2 点或总长小于 4 的笔画丢弃', () => {
    expect(snapToLines([[50, 53]], LINES)).toEqual([]);
    expect(snapToLines([[50, 53], [52, 53]], LINES)).toEqual([]);
  });

  it('lineText 与 [x1, x2] 有交集的项按顺序拼接', () => {
    expect(lineText(L1, 90, 110)).toBe('Cited passage');
    expect(lineText(L1, 250, 300)).toBe('');
  });
});
