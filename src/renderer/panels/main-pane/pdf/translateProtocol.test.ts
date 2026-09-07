import { describe, expect, it } from 'vitest';
import { GroupError } from './layoutProtocol';
import { describeTokenViolation, introducedMarkup, parseTranslations, tokenViolation } from './translateProtocol';

describe('parseTranslations（第二步：`<id>` + 译文 + `%%`）', () => {
  it('每组一个槽位，译文可跨多行，保留内部换行', () => {
    const r = parseTranslations('g1\n第一段\n%%\ng2\n甲\n乙\n%%\n', ['g1', 'g2']);
    expect(r.targets).toEqual({ g1: '第一段', g2: '甲\n乙' });
    expect(r.missing).toEqual([]);
  });
  it('头行允许模型把 kind 一并回显（`g1 | text`），只取 "|" 前的 id', () => {
    expect(parseTranslations('g1 | text\n译\n%%\n', ['g1']).targets).toEqual({ g1: '译' });
  });
  it('缺组 → 不抛，missing 按 expectedIds 顺序', () => {
    expect(parseTranslations('g2\n乙\n%%\n', ['g1', 'g2', 'g3']).missing).toEqual(['g1', 'g3']);
  });
  it('最后一组没有 %%（截断在组内）→ 那一组不收、算缺', () => {
    const r = parseTranslations('g1\n甲\n%%\ng2\n乙没写完', ['g1', 'g2']);
    expect(r.targets).toEqual({ g1: '甲' });
    expect(r.missing).toEqual(['g2']);
  });
  it('空译文 → 抛（否则右格涂白没字）', () => {
    expect(() => parseTranslations('g1\n%%\n', ['g1'])).toThrow(/没有译文/);
    expect(() => parseTranslations('g1\n   \n%%\n', ['g1'])).toThrow(/没有译文/);
  });
  it('未知 id / 重复 id → 抛', () => {
    expect(() => parseTranslations('g9\n译\n%%\n', ['g1'])).toThrow(/不在这次发出的组里/);
    expect(() => parseTranslations('g1\n甲\n%%\ng1\n乙\n%%\n', ['g1'])).toThrow(/出现了两次/);
  });
  it('头行不是 id 形状（模型把译文当头）→ 抛 GroupError', () => {
    expect(() => parseTranslations('深度学习\n%%\n', ['g1'])).toThrow(GroupError);
  });
});

describe('introducedMarkup（译文多出原文没有的 \\ / $ → 数学符号被改写成 LaTeX，spec 2026-09-07 §8.8）', () => {
  it('原文是数学斜体字符、译文改成 \\( \\) → 回「\\」', () => {
    expect(introducedMarkup('each node 𝑛𝑖 ∈ 𝑁', '每个节点 \\( n_i \\in N \\)')).toBe('\\');
  });
  it('译文用 $…$ → 回「$」', () => {
    expect(introducedMarkup('node 𝑛𝑖', '节点 $n_i$')).toBe('$');
  });
  it('原文本身带反斜杠（路径 / 转义）→ 译文带它不算违约', () => {
    expect(introducedMarkup('escape as \\n', '转义为 \\n')).toBeUndefined();
  });
  it('两个字符各自判：原文有 $ 没有 \\，译文多出 \\ 仍违约', () => {
    expect(introducedMarkup('costs $5', '花 $5，即 \\( c \\)')).toBe('\\');
  });
  it('干净的译文 → undefined', () => {
    expect(introducedMarkup('node 𝑛𝑖', '节点 𝑛𝑖')).toBeUndefined();
  });
});

describe('tokenViolation（每个记号在译文里恰出现一次，spec 2026-09-07 scripts §5.2）', () => {
  it('全对 → undefined（顺序可变、位置不查）', () => {
    expect(tokenViolation('node n{v1} in V{v2}', '在 V{v2} 中的节点 n{v1}')).toBeUndefined();
  });
  it('丢了 → missing', () => {
    expect(tokenViolation('for 𝑒{v1}. Next 𝑒{v2}', '接着 𝑒{v2}')).toEqual({ missing: ['v1'], dup: [], unknown: [] });
  });
  it('重复 → dup', () => {
    expect(tokenViolation('n{v1}', 'n{v1} 与 n{v1}')).toEqual({ missing: [], dup: ['v1'], unknown: [] });
  });
  it('译文里多出原文没有的记号 → unknown', () => {
    expect(tokenViolation('n{v1}', 'n{v1} 与 m{v9}')).toEqual({ missing: [], dup: [], unknown: ['v9'] });
  });
  it('没有记号的组永远不违约', () => {
    expect(tokenViolation('plain', '平的')).toBeUndefined();
  });
  it('describeTokenViolation：三类各自成句、顿号分隔', () => {
    expect(describeTokenViolation({ missing: ['v1', 'v2'], dup: [], unknown: ['v9'] })).toBe('丢 v1,v2、多出 v9');
    expect(describeTokenViolation({ missing: [], dup: ['v3'], unknown: [] })).toBe('重复 v3');
  });
});
