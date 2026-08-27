import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runSkillSync } from './skillSync';

function tmp(p: string) { return mkdtempSync(path.join(tmpdir(), p)); }

function makeBuiltinRoot(): string {
  const root = tmp('sync-src-');
  mkdirSync(path.join(root, 'demo', 'references'), { recursive: true });
  writeFileSync(path.join(root, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nzh-body');
  writeFileSync(path.join(root, 'demo', 'SKILL.en.md'), '---\nname: demo\ndescription: d\n---\nen-body');
  writeFileSync(path.join(root, 'demo', 'references', 'r.md'), 'zh-ref');
  return root;
}

function home() {
  const h = tmp('sync-home-');
  return {
    skillsDir: path.join(h, 'skills'),
    manifestPath: path.join(h, 'skills', '.manifest.json'),
    stagingRoot: path.join(h, 'staging'),
  };
}

describe('runSkillSync', () => {
  it('zh 落中文，en 落英文，变体文件都不落盘', async () => {
    const builtinRoot = makeBuiltinRoot();
    for (const [loc, want] of [['zh', 'zh-body'], ['en', 'en-body']] as const) {
      const h = home();
      const r = await runSkillSync({ builtinRoot, locale: loc, phase: 'startup', kydogVersion: '0.3.0', ...h });
      expect(r.state).toBe('ok');
      expect(readFileSync(path.join(h.skillsDir, 'demo', 'SKILL.md'), 'utf8')).toContain(want);
      expect(existsSync(path.join(h.skillsDir, 'demo', 'SKILL.en.md'))).toBe(false);
    }
  });

  it('第二次跑没有变化 → installedOrUpgraded 为空（两方比对生效）', async () => {
    const builtinRoot = makeBuiltinRoot();
    const h = home();
    const args = { builtinRoot, locale: 'zh' as const, phase: 'startup' as const, kydogVersion: '0.3.0', ...h };
    await runSkillSync(args);
    const r2 = await runSkillSync(args);
    expect(r2).toMatchObject({ state: 'ok', installedOrUpgraded: [] });
  });

  it('用户改过的内置 skill 被直接覆盖，不再产生冲突', async () => {
    const builtinRoot = makeBuiltinRoot();
    const h = home();
    const args = { builtinRoot, locale: 'zh' as const, phase: 'startup' as const, kydogVersion: '0.3.0', ...h };
    await runSkillSync(args);
    writeFileSync(path.join(h.skillsDir, 'demo', 'SKILL.md'), 'hand-edited');
    const r = await runSkillSync(args);
    expect(r).toMatchObject({ state: 'ok', installedOrUpgraded: ['demo'] });
    expect(readFileSync(path.join(h.skillsDir, 'demo', 'SKILL.md'), 'utf8')).toContain('zh-body');
  });

  it('切换 locale 会重写整棵树', async () => {
    const builtinRoot = makeBuiltinRoot();
    const h = home();
    await runSkillSync({ builtinRoot, locale: 'zh', phase: 'startup', kydogVersion: '0.3.0', ...h });
    await runSkillSync({ builtinRoot, locale: 'en', phase: 'locale-switch', kydogVersion: '0.3.0', ...h });
    expect(readFileSync(path.join(h.skillsDir, 'demo', 'SKILL.md'), 'utf8')).toContain('en-body');
  });

  it('用户自己的 skill 目录不被触碰，且列在 userSkills 里', async () => {
    const builtinRoot = makeBuiltinRoot();
    const h = home();
    mkdirSync(path.join(h.skillsDir, 'mine'), { recursive: true });
    writeFileSync(path.join(h.skillsDir, 'mine', 'SKILL.md'), 'mine');
    const r = await runSkillSync({ builtinRoot, locale: 'zh', phase: 'startup', kydogVersion: '0.3.0', ...h });
    expect(r).toMatchObject({ state: 'ok', userSkills: ['mine'] });
    expect(readFileSync(path.join(h.skillsDir, 'mine', 'SKILL.md'), 'utf8')).toBe('mine');
  });

  it('manifest 记过、当前已不是 builtin 的目录被当成孤儿删掉', async () => {
    const builtinRoot = makeBuiltinRoot();
    const h = home();
    mkdirSync(path.join(h.skillsDir, 'gone'), { recursive: true });
    writeFileSync(path.join(h.skillsDir, 'gone', 'SKILL.md'), 'x');
    mkdirSync(path.dirname(h.manifestPath), { recursive: true });
    writeFileSync(h.manifestPath, JSON.stringify({
      schemaVersion: 2, kydogVersion: '0.2.0', writtenAt: 'x', builtin: ['demo', 'gone'],
    }));
    await runSkillSync({ builtinRoot, locale: 'zh', phase: 'startup', kydogVersion: '0.3.0', ...h });
    expect(existsSync(path.join(h.skillsDir, 'gone'))).toBe(false);
  });

  it('manifest 损坏 → 照常同步，但跳过孤儿清理（旧目录留着）', async () => {
    const builtinRoot = makeBuiltinRoot();
    const h = home();
    mkdirSync(path.join(h.skillsDir, 'gone'), { recursive: true });
    writeFileSync(path.join(h.skillsDir, 'gone', 'SKILL.md'), 'x');
    writeFileSync(h.manifestPath, '{broken');
    const r = await runSkillSync({ builtinRoot, locale: 'zh', phase: 'startup', kydogVersion: '0.3.0', ...h });
    expect(r.state).toBe('ok');
    expect(existsSync(path.join(h.skillsDir, 'demo', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(h.skillsDir, 'gone'))).toBe(true);
  });

  it('skill 名下躺着的是普通文件而不是目录 → 照样整棵换掉，不卡死整轮同步', async () => {
    const builtinRoot = makeBuiltinRoot();
    const h = home();
    mkdirSync(h.skillsDir, { recursive: true });
    writeFileSync(path.join(h.skillsDir, 'demo'), 'not a dir');
    const r = await runSkillSync({ builtinRoot, locale: 'zh', phase: 'startup', kydogVersion: '0.3.0', ...h });
    expect(r).toMatchObject({ state: 'ok', installedOrUpgraded: ['demo'] });
    expect(readFileSync(path.join(h.skillsDir, 'demo', 'SKILL.md'), 'utf8')).toContain('zh-body');
  });

  it('替换失败 → 返回 failed 而不是抛，且带上 phase 与 skill', async () => {
    const builtinRoot = makeBuiltinRoot();
    const h = home();
    // 名字排在 demo 之前，保证它是第一个被处理的那个
    mkdirSync(path.join(builtinRoot, 'broken'), { recursive: true });
    writeFileSync(path.join(builtinRoot, 'broken', 'SKILL.md'), '---\nname: broken\ndescription: d\n---\nb');
    // 暂存根被一个普通文件占住 → replaceSkillTree 建暂存目录时就失败。
    // 不用「源文件换成目录」造 "not a regular file"：listSkillSourceFiles 只收普通文件，
    // 目录根本进不了投影，那种造法造不出失败。
    writeFileSync(h.stagingRoot, 'not a dir');
    const r = await runSkillSync({ builtinRoot, locale: 'en', phase: 'locale-switch', kydogVersion: '0.3.0', ...h });
    expect(r).toMatchObject({ state: 'failed', phase: 'locale-switch', skill: 'broken' });
  });
});
