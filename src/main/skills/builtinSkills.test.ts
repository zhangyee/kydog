import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listBuiltinSkills, listSkillSourceFiles, hashProjectedSkill } from './builtinSkills';
import { SKIP_WITHOUT_SYMLINK } from '../../test-support/symlinkCapability';

function makeFakeBuiltin(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bskills-'));
  mkdirSync(path.join(root, 'fastpaper'), { recursive: true });
  writeFileSync(path.join(root, 'fastpaper', 'SKILL.md'), '---\nname: fastpaper\ndescription: x\n---\nbody');
  writeFileSync(path.join(root, 'fastpaper', 'SKILL.en.md'), '---\nname: fastpaper\ndescription: x\n---\nen body');
  mkdirSync(path.join(root, 'fastpaper', 'references'), { recursive: true });
  writeFileSync(path.join(root, 'fastpaper', 'references', 'r.md'), 'r');
  // a non-skill stray file at root should be skipped
  writeFileSync(path.join(root, 'README.md'), 'noise');
  return root;
}

describe('listBuiltinSkills', () => {
  it('returns each subdirectory containing SKILL.md', () => {
    const root = makeFakeBuiltin();
    expect(listBuiltinSkills(root)).toEqual(['fastpaper']);
  });
});

describe('listSkillSourceFiles', () => {
  it('递归列出全部源文件（含 .en 变体），相对路径为 key', () => {
    const root = makeFakeBuiltin();
    expect(listSkillSourceFiles(root, 'fastpaper').sort()).toEqual(['SKILL.en.md', 'SKILL.md', 'references/r.md']);
  });

  it.skipIf(SKIP_WITHOUT_SYMLINK)('源侧出现非普通文件 → 抛错中止，不从投影里静默消失', () => {
    const root = makeFakeBuiltin();
    symlinkSync(path.join(root, 'fastpaper', 'SKILL.md'), path.join(root, 'fastpaper', 'alias.md'));
    expect(() => listSkillSourceFiles(root, 'fastpaper')).toThrow(/not a regular file/);
  });
});

describe('hashProjectedSkill', () => {
  it('key 是投影后路径，value 是被选中源文件的 sha', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bskills-'));
    mkdirSync(path.join(root, 'demo'), { recursive: true });
    writeFileSync(path.join(root, 'demo', 'SKILL.md'), 'zh');
    writeFileSync(path.join(root, 'demo', 'SKILL.en.md'), 'en');
    const zh = hashProjectedSkill(root, 'demo', 'zh');
    const en = hashProjectedSkill(root, 'demo', 'en');
    expect(Object.keys(zh)).toEqual(['SKILL.md']);
    expect(Object.keys(en)).toEqual(['SKILL.md']);
    expect(zh['SKILL.md']).not.toBe(en['SKILL.md']);   // 同一 key，不同源
  });
});
