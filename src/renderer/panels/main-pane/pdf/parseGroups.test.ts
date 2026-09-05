import { describe, it, expect } from 'vitest';
import { GroupError, parseGroups } from './parseGroups';

const ok = `1-2 | text
深度学习已展现出效果。
%%
3 | title
方法
%%
4 | skip
%%
`;

describe('parseGroups', () => {
  it('解析出组、kind 与译文', () => {
    expect(parseGroups(ok, [1, 2, 3, 4])).toEqual([
      { lines: [1, 2], kind: 'text', target: '深度学习已展现出效果。' },
      { lines: [3], kind: 'title', target: '方法' },
      { lines: [4], kind: 'skip' },
    ]);
  });
  it('译文可以跨多行', () => {
    const [g] = parseGroups('1 | text\n第一段\n第二段\n%%\n', [1]);
    expect(g.target).toBe('第一段\n第二段');
  });
  it('行号范围与单值混排，且不排序', () => {
    expect(parseGroups('3,1,2 | text\nX\n%%\n', [1, 2, 3])[0].lines).toEqual([3, 1, 2]);
    expect(parseGroups('1-3,7 | text\nX\n%%\n', [1, 2, 3, 7])[0].lines).toEqual([1, 2, 3, 7]);
  });

  it('漏行 → GroupError', () => {
    expect(() => parseGroups('1 | text\nX\n%%\n', [1, 2])).toThrow(GroupError);
  });
  it('重复行 → GroupError', () => {
    expect(() => parseGroups('1 | text\nX\n%%\n1 | text\nY\n%%\n', [1])).toThrow(GroupError);
  });
  it('多出没发过的行号 → GroupError', () => {
    expect(() => parseGroups('1,9 | text\nX\n%%\n', [1])).toThrow(GroupError);
  });
  it('kind 不认识 → GroupError', () => {
    expect(() => parseGroups('1 | heading\nX\n%%\n', [1])).toThrow(GroupError);
  });
  it('尾部被截断（最后一组没有 %%）→ GroupError（那一组的行会缺）', () => {
    expect(() => parseGroups('1 | text\nX\n%%\n2 | text\nY', [1, 2])).toThrow(GroupError);
  });

  it('text 空译文 → GroupError', () => {
    expect(() => parseGroups('1 | text\n%%\n', [1])).toThrow(GroupError);
  });
  it('text 纯空白译文 → GroupError', () => {
    expect(() => parseGroups('1 | text\n   \n%%\n', [1])).toThrow(GroupError);
  });
  it('formula 带了译文 → GroupError', () => {
    expect(() => parseGroups('1 | formula\nX\n%%\n', [1])).toThrow(GroupError);
  });
  it('期望集合不是 1..n（对半拆之后）照样校验', () => {
    expect(parseGroups('5-6 | text\nX\n%%\n', [5, 6])[0].lines).toEqual([5, 6]);
    expect(() => parseGroups('5 | text\nX\n%%\n', [5, 6])).toThrow(GroupError);
  });
});
