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
  it('baseDir contains SKILL.md → single candidate at relPath ""', async () => {
    const root = tmp();
    mkSkill(root, '', 'foo', 'desc');
    const r = await enumerateSkills(root);
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]).toMatchObject({ name: 'foo', description: 'desc', relPath: '' });
  });

  it('many sibling skills at depth 1', async () => {
    const root = tmp();
    mkSkill(root, 'a', 'a', 'da');
    mkSkill(root, 'b', 'b', 'db');
    const r = await enumerateSkills(root);
    expect(r.candidates.map(c => c.name).sort()).toEqual(['a', 'b']);
  });

  it('unwraps single-subdir wrapper (GitHub tarball shape)', async () => {
    const root = tmp();
    mkSkill(root, 'repo-abc/skill1', 'skill1', 'd1');
    mkSkill(root, 'repo-abc/skill2', 'skill2', 'd2');
    const r = await enumerateSkills(root);
    expect(r.candidates.map(c => c.name).sort()).toEqual(['skill1', 'skill2']);
    expect(r.candidates[0].relPath.startsWith('repo-abc/')).toBe(true);
  });

  it('throws KydogError(skill.invalid) when nothing found', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'empty'));
    await expect(enumerateSkills(root)).rejects.toThrow(/skill\.invalid|未找到/);
  });

  it('flags candidate with broken frontmatter via nameInvalid', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'broken'));
    writeFileSync(path.join(root, 'broken', 'SKILL.md'), '---\ndescription: only\n---');
    mkSkill(root, 'good', 'good', 'd');
    const r = await enumerateSkills(root);
    const broken = r.candidates.find(c => c.relPath === 'broken');
    expect(broken?.nameInvalid).toMatch(/name/);
    expect(r.candidates.find(c => c.relPath === 'good')?.nameInvalid).toBeUndefined();
  });

  it('does not unwrap when 2+ non-hidden subdirs lack SKILL.md', async () => {
    const root = tmp();
    mkdirSync(path.join(root, 'a-empty'));
    mkdirSync(path.join(root, 'b-empty'));
    await expect(enumerateSkills(root)).rejects.toThrow(/skill\.invalid|未找到/);
  });

  it('does not recurse into wrapper-of-wrapper', async () => {
    const root = tmp();
    mkSkill(root, 'wrap1/wrap2/skill', 'sk', 'd');
    await expect(enumerateSkills(root)).rejects.toThrow(/skill\.invalid|未找到/);
  });

  it('skips hidden directories during unwrap and one-level scan', async () => {
    const root = tmp();
    mkdirSync(path.join(root, '.git'));
    mkSkill(root, 'wrap/skill1', 'skill1', 'd');
    // .git as a sibling of wrap should not block "exactly 1 non-hidden subdir" gate
    const r = await enumerateSkills(root);
    expect(r.candidates.map(c => c.name)).toEqual(['skill1']);
  });
});
