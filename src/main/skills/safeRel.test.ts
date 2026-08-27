import { describe, it, expect } from 'vitest';
import { assertSafeRel } from './safeRel';

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
