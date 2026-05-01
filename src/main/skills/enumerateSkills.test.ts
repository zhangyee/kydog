import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enumerateSkills } from './enumerateSkills';

function mkSkill(root: string, rel: string, name: string, desc: string): void {
  const dir = path.join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody`);
}
function tmp() { return mkdtempSync(path.join(tmpdir(), 'enum-')); }

describe('enumerateSkills', () => {
  it('baseDir contains SKILL.md → single candidate at relPath ""', () => {
    const root = tmp();
    mkSkill(root, '', 'foo', 'desc');
    const r = enumerateSkills(root);
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]).toMatchObject({ name: 'foo', description: 'desc', relPath: '' });
  });

  it('many sibling skills at depth 1', () => {
    const root = tmp();
    mkSkill(root, 'a', 'a', 'da');
    mkSkill(root, 'b', 'b', 'db');
    const r = enumerateSkills(root);
    expect(r.candidates.map(c => c.name).sort()).toEqual(['a', 'b']);
  });

  it('unwraps single-subdir wrapper (GitHub tarball shape)', () => {
    const root = tmp();
    mkSkill(root, 'repo-abc/skill1', 'skill1', 'd1');
    mkSkill(root, 'repo-abc/skill2', 'skill2', 'd2');
    const r = enumerateSkills(root);
    expect(r.candidates.map(c => c.name).sort()).toEqual(['skill1', 'skill2']);
    expect(r.candidates[0].relPath.startsWith('repo-abc/')).toBe(true);
  });

  it('throws KydogError(skill.invalid) when nothing found', () => {
    const root = tmp();
    mkdirSync(path.join(root, 'empty'));
    expect(() => enumerateSkills(root)).toThrow(/skill\.invalid|未找到/);
  });

  it('flags candidate with broken frontmatter via nameInvalid', () => {
    const root = tmp();
    mkdirSync(path.join(root, 'broken'));
    writeFileSync(path.join(root, 'broken', 'SKILL.md'), '---\ndescription: only\n---');
    mkSkill(root, 'good', 'good', 'd');
    const r = enumerateSkills(root);
    const broken = r.candidates.find(c => c.relPath === 'broken');
    expect(broken?.nameInvalid).toMatch(/name/);
    expect(r.candidates.find(c => c.relPath === 'good')?.nameInvalid).toBeUndefined();
  });
});
