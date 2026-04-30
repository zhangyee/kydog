import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { classifySkill, applyOverrides } from './skillSync';

function tmp() { return mkdtempSync(path.join(tmpdir(), 'sync-')); }

describe('classifySkill', () => {
  it('skill not on disk → action=install, no conflicts', () => {
    const r = classifySkill({
      shippedFiles: { 'SKILL.md': 'A' },
      recordedFiles: {},
      diskHashes: {},          // disk dir absent
      diskExists: false,
    });
    expect(r.action).toBe('install');
    expect(r.conflicts).toEqual([]);
    expect(r.toWrite).toEqual(['SKILL.md']);
  });

  it('all files match shipped → action=skip', () => {
    const r = classifySkill({
      shippedFiles: { 'SKILL.md': 'A', 'r/r.md': 'B' },
      recordedFiles: { 'SKILL.md': 'A', 'r/r.md': 'B' },
      diskHashes: { 'SKILL.md': 'A', 'r/r.md': 'B' },
      diskExists: true,
    });
    expect(r.action).toBe('skip');
  });

  it('user untouched, ship updated → action=auto-upgrade', () => {
    const r = classifySkill({
      shippedFiles: { 'SKILL.md': 'NEW' },
      recordedFiles: { 'SKILL.md': 'OLD' },
      diskHashes:    { 'SKILL.md': 'OLD' },
      diskExists: true,
    });
    expect(r.action).toBe('auto-upgrade');
    expect(r.toWrite).toEqual(['SKILL.md']);
  });

  it('user changed AND shipped changed → action=conflict', () => {
    const r = classifySkill({
      shippedFiles: { 'SKILL.md': 'NEW' },
      recordedFiles: { 'SKILL.md': 'OLD' },
      diskHashes:    { 'SKILL.md': 'USER' },
      diskExists: true,
    });
    expect(r.action).toBe('conflict');
    expect(r.conflicts).toEqual([{ relPath: 'SKILL.md', shippedSha: 'NEW', diskSha: 'USER', recordedSha: 'OLD' }]);
  });

  it('partial: one file conflict, one missing → action=conflict, missing in toWrite', () => {
    const r = classifySkill({
      shippedFiles: { 'SKILL.md': 'NEW', 'r.md': 'X' },
      recordedFiles: { 'SKILL.md': 'OLD' },
      diskHashes:    { 'SKILL.md': 'USER' },  // r.md missing on disk
      diskExists: true,
    });
    expect(r.action).toBe('conflict');
    expect(r.conflicts.map(c => c.relPath)).toEqual(['SKILL.md']);
    // missing files become non-conflicting auto-writes baked into the conflict result
    expect(r.toWrite).toEqual(['r.md']);
  });

  it('user added an extra file in skill dir → not in conflicts and not in toWrite', () => {
    const r = classifySkill({
      shippedFiles: { 'SKILL.md': 'A' },
      recordedFiles: { 'SKILL.md': 'A' },
      diskHashes:    { 'SKILL.md': 'A', 'notes.md': 'USER_EXTRA' },
      diskExists: true,
    });
    expect(r.action).toBe('skip');
    expect(r.toWrite).toEqual([]);
  });
});

describe('applyOverrides', () => {
  it('writes selected files + updates manifest', async () => {
    const root = tmp();
    const built = path.join(root, 'src-skills');
    const target = path.join(root, 'kydog-skills');
    const manifest = path.join(target, '.manifest.json');
    mkdirSync(path.join(built, 'fastpaper', 'r'), { recursive: true });
    writeFileSync(path.join(built, 'fastpaper', 'SKILL.md'), 'NEW');
    writeFileSync(path.join(built, 'fastpaper', 'r', 'r.md'), 'NEW2');

    const writtenManifest = await applyOverrides({
      builtinRoot: built,
      kydogSkillsDir: target,
      manifestPath: manifest,
      kydogVersion: '0.2.0',
      operations: [
        { skill: 'fastpaper', files: ['SKILL.md', 'r/r.md'] },
      ],
    });

    expect(readFileSync(path.join(target, 'fastpaper', 'SKILL.md'), 'utf-8')).toBe('NEW');
    expect(readFileSync(path.join(target, 'fastpaper', 'r', 'r.md'), 'utf-8')).toBe('NEW2');
    expect(writtenManifest.builtin.fastpaper.files['SKILL.md']).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(manifest)).toBe(true);
  });
});
