import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, promises as fsp } from 'node:fs';
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

  it('stage→targetDir 的 rename 失败时把旧树换回去，暂存目录也不留垃圾', async () => {
    const srcRoot = makeSrc();
    const home = tmp('rst-home-');
    const targetDir = path.join(home, 'skills', 'demo');
    const stagingRoot = path.join(home, 'staging');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'SKILL.md'), 'old');

    // 三次 rename 依次是：①targetDir→trash ②stage→targetDir ③回滚 trash→targetDir。
    // 只让第②次失败，模拟替换途中出错；①③要放行到真实实现，否则测试本身就在骗自己。
    const originalRename = fsp.rename.bind(fsp);
    let calls = 0;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (...args: Parameters<typeof fsp.rename>) => {
      calls += 1;
      if (calls === 2) throw new Error('boom: rename stage to targetDir failed');
      return originalRename(...args);
    });

    try {
      await expect(replaceSkillTree({
        srcRoot, skillName: 'demo', projection: EN, targetDir, stagingRoot,
      })).rejects.toThrow('boom: rename stage to targetDir failed');
    } finally {
      spy.mockRestore();
    }

    expect(readFileSync(path.join(targetDir, 'SKILL.md'), 'utf8')).toBe('old');
    expect(readdirSync(stagingRoot)).toEqual([]);
  });

  it('回滚 rename 本身也失败时保留原始错误，trash 留在暂存目录等人工恢复', async () => {
    const srcRoot = makeSrc();
    const home = tmp('rst-home-');
    const targetDir = path.join(home, 'skills', 'demo');
    const stagingRoot = path.join(home, 'staging');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'SKILL.md'), 'old');

    // 第②次（stage→targetDir）和第③次（回滚 trash→targetDir）都失败，
    // 模拟「换回去」本身也出错的双重失败场景。
    const originalRename = fsp.rename.bind(fsp);
    let calls = 0;
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (...args: Parameters<typeof fsp.rename>) => {
      calls += 1;
      if (calls === 2) throw new Error('boom: rename stage to targetDir failed');
      if (calls === 3) throw new Error('boom: rollback rename failed too');
      return originalRename(...args);
    });

    try {
      // 抛出的必须是第②次的原始错误，不能被第③次的回滚错误盖掉
      await expect(replaceSkillTree({
        srcRoot, skillName: 'demo', projection: EN, targetDir, stagingRoot,
      })).rejects.toThrow('boom: rename stage to targetDir failed');
    } finally {
      spy.mockRestore();
    }

    // targetDir 此时两头落空（既非旧树也非新树）——这是已知的、被记录下来的降级状态，
    // 旧树内容躺在 trash 里等人工恢复，不会被静默丢弃。
    expect(existsSync(targetDir)).toBe(false);
    const trashEntries = readdirSync(stagingRoot).filter((f) => f.startsWith('.trash-'));
    expect(trashEntries).toHaveLength(1);
    expect(readFileSync(path.join(stagingRoot, trashEntries[0], 'SKILL.md'), 'utf8')).toBe('old');
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
