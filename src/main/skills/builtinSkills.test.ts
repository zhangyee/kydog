import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listBuiltinSkills, hashBuiltinSkill } from './builtinSkills';

function makeFakeBuiltin(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bskills-'));
  mkdirSync(path.join(root, 'fastpaper'), { recursive: true });
  writeFileSync(path.join(root, 'fastpaper', 'SKILL.md'), '---\nname: fastpaper\ndescription: x\n---\nbody');
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

describe('hashBuiltinSkill', () => {
  it('returns sha256 for every file under skill dir, recursive, relative path keys', () => {
    const root = makeFakeBuiltin();
    const m = hashBuiltinSkill(root, 'fastpaper');
    expect(Object.keys(m).sort()).toEqual(['SKILL.md', 'references/r.md']);
    expect(m['SKILL.md']).toMatch(/^[0-9a-f]{64}$/);
  });
});
