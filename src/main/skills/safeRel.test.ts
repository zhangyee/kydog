import { describe, it, expect } from 'vitest';
import { assertSafeRel, assertSafeSkillName } from './safeRel';

describe('assertSafeRel', () => {
  it('接受普通相对路径', () => {
    expect(() => assertSafeRel('SKILL.md', 't')).not.toThrow();
    expect(() => assertSafeRel('references/writing.md', 't')).not.toThrow();
  });

  it('拒绝父级穿越', () => {
    expect(() => assertSafeRel('../evil.md', 't')).toThrow(/unsafe/);
    expect(() => assertSafeRel('a/../../evil.md', 't')).toThrow(/unsafe/);
  });

  it('拒绝绝对路径', () => {
    expect(() => assertSafeRel('/etc/passwd', 't')).toThrow(/unsafe/);
  });

  it('拒绝 Windows 盘符与反斜杠', () => {
    expect(() => assertSafeRel('C:\\evil', 't')).toThrow(/unsafe/);
    expect(() => assertSafeRel('a\\b', 't')).toThrow(/unsafe/);
  });

  it('拒绝空串与 NUL', () => {
    expect(() => assertSafeRel('', 't')).toThrow(/unsafe/);
    expect(() => assertSafeRel('a\0b', 't')).toThrow(/unsafe/);
  });

  it('错误信息里带上下文，方便定位是谁传进来的', () => {
    expect(() => assertSafeRel('../x', 'projection')).toThrow(/projection/);
  });
});

describe('assertSafeSkillName', () => {
  it('接受普通目录名', () => {
    expect(() => assertSafeSkillName('fastpaper', 't')).not.toThrow();
    expect(() => assertSafeSkillName('paper-summary', 't')).not.toThrow();
  });

  it('拒绝 `.` —— 它会让 rm 的目标退回 skills 目录本身', () => {
    expect(() => assertSafeSkillName('.', 't')).toThrow(/unsafe/);
  });

  it('拒绝父级穿越与绝对路径', () => {
    expect(() => assertSafeSkillName('..', 't')).toThrow(/unsafe/);
    expect(() => assertSafeSkillName('../x', 't')).toThrow(/unsafe/);
    expect(() => assertSafeSkillName('/etc', 't')).toThrow(/unsafe/);
  });

  it('拒绝多段路径：skill 名只能是一个目录名', () => {
    expect(() => assertSafeSkillName('a/b', 't')).toThrow(/unsafe/);
  });

  it('错误信息里带上下文', () => {
    expect(() => assertSafeSkillName('.', 'orphan cleanup')).toThrow(/orphan cleanup/);
  });
});
