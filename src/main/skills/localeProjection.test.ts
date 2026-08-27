import { describe, it, expect } from 'vitest';
import { projectSkillFiles } from './localeProjection';

const obj = (m: Map<string, string>) => Object.fromEntries([...m.entries()].sort());

describe('projectSkillFiles', () => {
  it('zh 取无后缀文件，变体不落盘', () => {
    expect(obj(projectSkillFiles(['SKILL.md', 'SKILL.en.md'], 'zh')))
      .toEqual({ 'SKILL.md': 'SKILL.md' });
  });

  it('en 取 .en 变体，且投影后仍叫 SKILL.md', () => {
    expect(obj(projectSkillFiles(['SKILL.md', 'SKILL.en.md'], 'en')))
      .toEqual({ 'SKILL.md': 'SKILL.en.md' });
  });

  it('en 缺变体时回落到默认文件', () => {
    expect(obj(projectSkillFiles(['SKILL.md'], 'en')))
      .toEqual({ 'SKILL.md': 'SKILL.md' });
  });

  it('子目录走同一规则', () => {
    const r = projectSkillFiles(
      ['references/writing.md', 'references/writing.en.md', 'references/layout.md'], 'en');
    expect(obj(r)).toEqual({
      'references/writing.md': 'references/writing.en.md',
      'references/layout.md': 'references/layout.md',
    });
  });

  it('白名单外的中缀原样保留，不当成 locale', () => {
    const rels = ['vendor.min.js', 'notes.ja.md', 'a.b.c.txt'];
    for (const loc of ['zh', 'en'] as const) {
      expect(obj(projectSkillFiles(rels, loc)))
        .toEqual({ 'vendor.min.js': 'vendor.min.js', 'notes.ja.md': 'notes.ja.md', 'a.b.c.txt': 'a.b.c.txt' });
    }
  });

  it('两段名不算变体（需要 base.locale.ext 三段）', () => {
    expect(obj(projectSkillFiles(['Makefile.en'], 'en')))
      .toEqual({ 'Makefile.en': 'Makefile.en' });
  });

  it('只有 .en 没有 base：en 下投影出来，zh 下消失', () => {
    expect(obj(projectSkillFiles(['SKILL.en.md'], 'en'))).toEqual({ 'SKILL.md': 'SKILL.en.md' });
    expect(obj(projectSkillFiles(['SKILL.en.md'], 'zh'))).toEqual({});
  });

  it('显式 .zh 变体在 zh 下压过无后缀文件', () => {
    expect(obj(projectSkillFiles(['SKILL.md', 'SKILL.zh.md'], 'zh')))
      .toEqual({ 'SKILL.md': 'SKILL.zh.md' });
  });

  it('非法相对路径直接抛', () => {
    expect(() => projectSkillFiles(['../evil.md'], 'zh')).toThrow(/unsafe/);
  });
});
