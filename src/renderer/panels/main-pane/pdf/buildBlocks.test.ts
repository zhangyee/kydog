import { describe, it, expect } from 'vitest';
import type { PageLine } from '../../../../shared/zhSidecar';
import { buildBlocks } from './buildBlocks';

const line = (n: number, x: number, y: number, w: number, size: number, text: string): PageLine =>
  ({ n, x, y, w, h: size, size, text });

describe('buildBlocks', () => {
  const lines = [
    line(1, 72, 90, 400, 10, 'Deep learning has'),
    line(2, 72, 104, 380, 10, 'shown results.'),
    line(3, 72, 130, 120, 14, '2 Method'),
  ];

  it('bbox 取并集，id 按最小行号升序编', () => {
    const out = buildBlocks(3, lines, [
      { lines: [3], kind: 'title', target: '2 方法' },
      { lines: [1, 2], kind: 'text', target: '深度学习已展现出结果。' },
    ]);
    expect(out.map((b) => b.id)).toEqual(['p3-b01', 'p3-b02']);
    expect(out[0]).toMatchObject({ page: 3, x: 72, y: 90, width: 400, height: 24, kind: 'text' });
    expect(out[1]).toMatchObject({ x: 72, y: 130, width: 120, height: 14, kind: 'title' });
  });

  it('fontSize 取中位数：奇数取中间，偶数取较小的那个', () => {
    const l = [line(1, 0, 0, 10, 10, 'a'), line(2, 0, 20, 10, 12, 'b'), line(3, 0, 40, 10, 20, 'c')];
    expect(buildBlocks(1, l, [{ lines: [1, 2, 3], kind: 'text', target: 'x' }])[0].fontSize).toBe(12);
    expect(buildBlocks(1, l, [{ lines: [1, 2], kind: 'text', target: 'x' }])[0].fontSize).toBe(10);
  });

  it('source 按模型给出的顺序拼，不排序', () => {
    const out = buildBlocks(1, lines, [{ lines: [2, 1], kind: 'text', target: 'x' }]);
    expect(out[0].source).toBe('shown results. Deep learning has');
  });

  it('行尾连字符 + 下一行小写开头 → 去掉连字符直接连；否则空格连', () => {
    const l = [line(1, 0, 0, 10, 10, 'trans-'), line(2, 0, 20, 10, 10, 'lation works'), line(3, 0, 40, 10, 10, 'Next')];
    expect(buildBlocks(1, l, [{ lines: [1, 2, 3], kind: 'text', target: 'x' }])[0].source)
      .toBe('translation works Next');
  });

  it('不可译的 kind 不写 target', () => {
    const out = buildBlocks(1, lines, [{ lines: [3], kind: 'formula' }]);
    expect(out[0].target).toBeUndefined();
    expect('target' in out[0]).toBe(false);
  });

  it('行号在这一页找不到的组被跳过（防御，正常不会发生）', () => {
    expect(buildBlocks(1, lines, [{ lines: [99], kind: 'text', target: 'x' }])).toEqual([]);
  });
});
