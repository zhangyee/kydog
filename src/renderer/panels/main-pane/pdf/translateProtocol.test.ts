import { describe, expect, it } from 'vitest';
import { GroupError } from './layoutProtocol';
import { introducedMarkup, parseTranslations } from './translateProtocol';

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
