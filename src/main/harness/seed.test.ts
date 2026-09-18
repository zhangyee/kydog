import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDisplayName } from './names';
import { renderTemplate, seedHarnessFiles } from './seed';
import { harnessTemplates } from './templates';
import { readHarnessState, HARNESS_STATE_FILE } from './harnessState';

describe('validateDisplayName', () => {
  it('接受中文/含空格/trim', () => {
    expect(validateDisplayName(' 老张 ')).toBe('老张');
    expect(validateDisplayName('Dr. Zhang')).toBe('Dr. Zhang');
  });
  it('拒绝空、超长、换行、控制字符、非字符串', () => {
    expect(validateDisplayName('')).toBeNull();
    expect(validateDisplayName('  ')).toBeNull();
    expect(validateDisplayName('a'.repeat(65))).toBeNull();
    expect(validateDisplayName('a\nb')).toBeNull();
    expect(validateDisplayName('a\tb')).toBeNull();
    expect(validateDisplayName(42)).toBeNull();
  });
});

describe('renderTemplate', () => {
  const tpl = '---\nname: {{userName}}\n---\n\n称呼 {{userName}}';
  it('front matter 用 JSON.stringify（引号/反斜杠安全），正文用原值', () => {
    const out = renderTemplate(tpl, { userName: 'A"\\B', agentName: 'KyDog' });
    expect(out).toContain(`name: ${JSON.stringify('A"\\B')}`);
    expect(out).toContain('称呼 A"\\B');
  });
  // Windows 上 core.autocrlf 把模板签出成 CRLF：围栏只认 \n 的话会掉进「无 front
  // matter」分支，把原值原样塞进 front matter，name 里一个冒号就写出不合法的 YAML。
  it('CRLF 模板同样识别 front matter（签出换行不影响判定）', () => {
    const out = renderTemplate(tpl.replaceAll('\n', '\r\n'), { userName: 'A: B', agentName: 'KyDog' });
    expect(out).toContain(`name: ${JSON.stringify('A: B')}`);
    expect(out).toContain('称呼 A: B');
  });
  it('无 front matter 的模板整体按原值替换', () => {
    expect(renderTemplate('hi {{agentName}}', { userName: 'u', agentName: '狗哥' })).toBe('hi 狗哥');
  });
});

describe('seedHarnessFiles', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-seed-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('缺失才写：三文件落盘、front matter 含称呼、按 locale 选模板', async () => {
    const r = await seedHarnessFiles({ locale: 'zh', userName: '老张', agentName: '狗哥' }, dir);
    expect(r.created.sort()).toEqual(['AGENTS.md', 'SOUL.md', 'USER.md']);
    expect(readFileSync(path.join(dir, 'USER.md'), 'utf8')).toContain('name: "老张"');
    expect(readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toContain('name: "狗哥"');
    expect(readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toContain('陌生不等于浅薄');
  });

  it('en locale 播英文模板', async () => {
    await seedHarnessFiles({ locale: 'en', userName: 'You', agentName: 'KyDog' }, dir);
    expect(readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toContain("You're not a chatbot");
  });

  it('已存在跳过不覆盖（wx）', async () => {
    writeFileSync(path.join(dir, 'SOUL.md'), 'MINE');
    const r = await seedHarnessFiles({ locale: 'zh', userName: 'You', agentName: 'KyDog' }, dir);
    expect(r.skipped).toEqual(['SOUL.md']);
    expect(r.created.sort()).toEqual(['AGENTS.md', 'USER.md']);
    expect(readFileSync(path.join(dir, 'SOUL.md'), 'utf8')).toBe('MINE');
  });

  it('只为这次真正创建的文件记状态（模板原文 + 语言）；已存在跳过的不记', async () => {
    writeFileSync(path.join(dir, 'SOUL.md'), 'MINE');
    await seedHarnessFiles({ locale: 'en', userName: 'You', agentName: 'KyDog' }, dir);
    const t = harnessTemplates('en');
    const { files } = await readHarnessState(dir);
    expect(files).toEqual({
      'USER.md': { locale: 'en', template: t.user, keptTemplateSha: null },
      'AGENTS.md': { locale: 'en', template: t.agents, keptTemplateSha: null },
    });
    // 记的是占位符未替换的原文，不是渲染结果：判「改没改过」要拿它配当前名字重渲染（决策 6）。
    expect(files['USER.md']?.template).toContain('{{userName}}');
  });

  it('状态写不进去不让播种失败（R1 下次会补记）', async () => {
    mkdirSync(path.join(dir, HARNESS_STATE_FILE));   // 占住文件名：rename 到一个目录上必失败
    const r = await seedHarnessFiles({ locale: 'zh', userName: 'u', agentName: 'a' }, dir);
    expect(r.created.sort()).toEqual(['AGENTS.md', 'SOUL.md', 'USER.md']);
  });

  it('目标目录不存在 → throw（非 EEXIST 不吞）', async () => {
    await expect(seedHarnessFiles({ locale: 'zh', userName: 'u', agentName: 'a' },
      path.join(dir, 'no', 'such'))).rejects.toThrow();
    expect(existsSync(path.join(dir, 'SOUL.md'))).toBe(false);
  });
});
