import { describe, it, expect } from 'vitest';
import { GroupError, parseGroups, TRANSLATABLE } from './parseGroups';
import { BLOCK_KINDS } from '../../../../shared/zhSidecar';

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

  /**
   * 「不可译」在实现里是**隐式补集**（上面按 `else` 分派，没有第二张表），所以 `BLOCK_KINDS`
   * 加第七个值时运行期与编译期都不会有任何信号：新 kind 直接落进「必须没有译文」那一支，
   * 谁都不会注意到。这条守卫把补集**手写出来**再对着全集做集合相等——正因为手写，加了新 kind
   * 而不来这里表态就会红。从 BLOCK_KINDS 现推补集的写法守不住任何东西（那样永远相等）。
   */
  it('可译 / 不可译两张表合起来正好是 BLOCK_KINDS，且不相交', () => {
    const NON_TRANSLATABLE = ['formula', 'table', 'skip'];   // 手写，故意不从 BLOCK_KINDS 现推
    expect(new Set([...TRANSLATABLE, ...NON_TRANSLATABLE]), '有 kind 没被这两张表覆盖到')
      .toEqual(new Set(BLOCK_KINDS));
    expect([...TRANSLATABLE].filter((k) => NON_TRANSLATABLE.includes(k)), '两张表有重叠').toEqual([]);
    expect(TRANSLATABLE.size + NON_TRANSLATABLE.length).toBe(BLOCK_KINDS.length);
  });
});
