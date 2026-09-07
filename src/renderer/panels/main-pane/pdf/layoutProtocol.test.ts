import { describe, expect, it } from 'vitest';
import { BLOCK_KINDS } from '../../../../shared/zhSidecar';
import { GroupError, TRANSLATABLE, parseLayout } from './layoutProtocol';

describe('parseLayout（第一步：每组一行 `<ids> | <kind>`）', () => {
  it('解析出组与 kind，顺序照输出、行号不排序', () => {
    const r = parseLayout('3,1-2 | text\n4 | title\n5 | skip\n', [1, 2, 3, 4, 5]);
    expect(r.groups).toEqual([{ lines: [3, 1, 2], kind: 'text' }, { lines: [4], kind: 'title' }, { lines: [5], kind: 'skip' }]);
    expect(r.missing).toEqual([]);
  });
  it('空行跳过；带 \\r\\n 也行', () => {
    expect(parseLayout('\r\n1 | text\r\n\r\n2 | skip\r\n', [1, 2]).groups).toHaveLength(2);
  });
  it('缺行 → 不抛，missing 按 expected 顺序', () => {
    expect(parseLayout('1 | text\n4 | skip\n', [1, 2, 3, 4]).missing).toEqual([2, 3]);
  });
  it('没有 "|" → 抛', () => {
    expect(() => parseLayout('1 text\n', [1])).toThrow(GroupError);
  });
  it('行号不认识 / 范围反了 / 空项 → 抛', () => {
    expect(() => parseLayout('a | text\n', [1])).toThrow(/行号不认识/);
    expect(() => parseLayout('3-1 | text\n', [1, 2, 3])).toThrow(/范围反了/);
    expect(() => parseLayout('1,,2 | text\n', [1, 2])).toThrow(/空项/);
  });
  it('kind 不认识 → 抛，且信息里列出全部合法值', () => {
    expect(() => parseLayout('1 | paragraph\n', [1])).toThrow(new RegExp(BLOCK_KINDS.join(' / ')));
  });
  it('重复行号 → 抛；未知行号（把坐标当行号）→ 抛，且排在缺行判定之前', () => {
    expect(() => parseLayout('1-2 | text\n2 | skip\n', [1, 2])).toThrow(/出现在多个组/);
    expect(() => parseLayout('1 | text\n303 | skip\n', [1, 2])).toThrow(/不在这次发出的行里/);
  });
  it('译文混进来（第二步的格式）→ 当成没有 "|" 的行抛，不静默吞', () => {
    expect(() => parseLayout('1 | text\n深度学习\n', [1])).toThrow(GroupError);
  });
});

describe('TRANSLATABLE 与 BLOCK_KINDS 的补集（code 落在不可译一侧）', () => {
  it('补集恰是 formula / table / code / skip', () => {
    expect(BLOCK_KINDS.filter((k) => !TRANSLATABLE.has(k))).toEqual(['formula', 'table', 'code', 'skip']);
  });
});
