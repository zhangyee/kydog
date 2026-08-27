import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { replaceSkillTree } from './replaceSkillTree';

function tmp(p: string) { return mkdtempSync(path.join(tmpdir(), p)); }

function makeSrc(): string {
  const root = tmp('rst-src-');
  mkdirSync(path.join(root, 'demo', 'references'), { recursive: true });
  writeFileSync(path.join(root, 'demo', 'SKILL.md'), 'zh-body');
  writeFileSync(path.join(root, 'demo', 'SKILL.en.md'), 'en-body');
  writeFileSync(path.join(root, 'demo', 'references', 'r.md'), 'zh-ref');
  return root;
}

const EN = new Map([['SKILL.md', 'SKILL.en.md'], ['references/r.md', 'references/r.md']]);

describe('replaceSkillTree', () => {
  it('目标不存在时建出整棵投影树，变体文件不落盘', async () => {
    const srcRoot = makeSrc();
    const home = tmp('rst-home-');
    const targetDir = path.join(home, 'skills', 'demo');
    await replaceSkillTree({ srcRoot, skillName: 'demo', projection: EN, targetDir, stagingRoot: path.join(home, 'staging') });
    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('en-body');
    expect(readFileSync(path.join(targetDir, 'references', 'r.md'), 'utf8')).toBe('zh-ref');
    expect(existsSync(path.join(targetDir, 'SKILL.en.md'))).toBe(false);
  });

  it('替换掉旧树，旧树里多出来的文件消失', async () => {
    const srcRoot = makeSrc();
    const home = tmp('rst-home-');
    const targetDir = path.join(home, 'skills', 'demo');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'SKILL.md'), 'old');
    writeFileSync(path.join(targetDir, 'stale.md'), 'stale');
    await replaceSkillTree({ srcRoot, skillName: 'demo', projection: EN, targetDir, stagingRoot: path.join(home, 'staging') });
    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('en-body');
    expect(existsSync(path.join(targetDir, 'stale.md'))).toBe(false);
  });

  it('源文件缺失时抛错，且旧树逐字节不变', async () => {
    const srcRoot = makeSrc();
    const home = tmp('rst-home-');
    const targetDir = path.join(home, 'skills', 'demo');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'SKILL.md'), 'old');
    const broken = new Map([['SKILL.md', 'SKILL.en.md'], ['gone.md', 'gone.md']]);
    await expect(replaceSkillTree({
      srcRoot, skillName: 'demo', projection: broken, targetDir, stagingRoot: path.join(home, 'staging'),
    })).rejects.toThrow();
    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('old');
  });

  it('源侧出现软链直接报错，不静默跳过', async () => {
    const srcRoot = makeSrc();
    symlinkSync('/etc/hosts', path.join(srcRoot, 'demo', 'link.md'));
    const home = tmp('rst-home-');
    const targetDir = path.join(home, 'skills', 'demo');
    const p = new Map([['link.md', 'link.md']]);
    await expect(replaceSkillTree({
      srcRoot, skillName: 'demo', projection: p, targetDir, stagingRoot: path.join(home, 'staging'),
    })).rejects.toThrow(/not a regular file/);
  });

  it('非法投影路径直接抛，不产生任何写入', async () => {
    const srcRoot = makeSrc();
    const home = tmp('rst-home-');
    const targetDir = path.join(home, 'skills', 'demo');
    const evil = new Map([['../escape.md', 'SKILL.md']]);
    await expect(replaceSkillTree({
      srcRoot, skillName: 'demo', projection: evil, targetDir, stagingRoot: path.join(home, 'staging'),
    })).rejects.toThrow(/unsafe/);
    expect(existsSync(path.join(home, 'escape.md'))).toBe(false);
  });

  it('成功后暂存目录里不留垃圾', async () => {
    const srcRoot = makeSrc();
    const home = tmp('rst-home-');
    const stagingRoot = path.join(home, 'staging');
    await replaceSkillTree({
      srcRoot, skillName: 'demo', projection: EN,
      targetDir: path.join(home, 'skills', 'demo'), stagingRoot,
    });
    expect(readdirSync(stagingRoot)).toEqual([]);
  });
});
