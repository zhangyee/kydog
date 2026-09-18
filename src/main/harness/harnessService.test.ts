import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessService } from './harnessService';
import { readHarnessState, writeHarnessState } from './harnessState';
import { templateSha } from './harnessAssess';
import { harnessTemplate } from './templates';
import { renderTemplate } from './seed';
import { getIdentity } from './identityService';

const OLD_AGENTS = '# AGENTS —— 旧版\n\n只有一节。\n';

describe('harnessService', () => {
  let dir: string;
  let locale: 'zh' | 'en';
  const svc = () => createHarnessService({
    dir,
    getLocale: async () => locale,
    getNames: () => getIdentity(dir),
    now: () => new Date(2026, 8, 17, 23, 30),       // 本地时间 2026-09-17
  });
  const f = (name: string) => path.join(dir, name);
  const read = (name: string) => readFileSync(f(name), 'utf8');
  const current = (name: 'SOUL.md' | 'USER.md' | 'AGENTS.md', names = { userName: 'You', agentName: 'KyDog' }) =>
    renderTemplate(harnessTemplate(locale, name), names);

  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-hsvc-')); locale = 'zh'; });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  /** 预置「旧模板写出的 AGENTS.md + 对应记录」—— 升级后老用户手里的样子。 */
  async function seedOldAgents() {
    writeFileSync(f('AGENTS.md'), OLD_AGENTS);
    await writeHarnessState({ schemaVersion: 1, files: { 'AGENTS.md': { locale: 'zh', template: OLD_AGENTS, keptTemplateSha: null } } }, dir);
  }

  describe('status', () => {
    it('三份按固定顺序给出；不存在的是 missing，旧模板写的是 available + unchanged', async () => {
      await seedOldAgents();
      const { files } = await svc().status();
      expect(files.map((x) => [x.name, x.template, x.edit])).toEqual([
        ['SOUL.md', 'missing', null], ['USER.md', 'missing', null], ['AGENTS.md', 'available', 'unchanged'],
      ]);
      expect(files[2]).toMatchObject({ templateLocale: 'zh', localeDiffers: false });
    });

    it('老用户的文件恰好等于当前模板 → latest 并补记；补记后改一个字仍是 latest（R2），不是 available', async () => {
      writeFileSync(f('SOUL.md'), current('SOUL.md', { userName: 'You', agentName: '狗哥' }));
      expect((await svc().status()).files[0].template).toBe('latest');
      expect((await readHarnessState(dir)).files['SOUL.md']).toEqual({ locale: 'zh', template: harnessTemplate('zh', 'SOUL.md'), keptTemplateSha: null });
      writeFileSync(f('SOUL.md'), read('SOUL.md') + '\n我补的一句\n');
      expect((await svc().status()).files[0].template).toBe('latest');
    });

    it('除了不存在之外读不出来 → 整体报错，不猜成 missing（同一目录下文件正常时读得出来）', async () => {
      writeFileSync(f('USER.md'), current('USER.md'));
      expect((await svc().status()).files[1].template).toBe('latest');
      rmSync(f('USER.md'));
      mkdirSync(f('USER.md'));                           // 读一个目录 → EISDIR
      await expect(svc().status()).rejects.toThrow();
    });
  });

  describe('apply：更新', () => {
    it('先备份再写：新文件等于当前模板渲染（名字保留），备份逐字等于旧内容，记录换成新模板', async () => {
      writeFileSync(f('USER.md'), '---\nname: "老张"\n---\n\n旧的 USER\n');
      const { results } = await svc().apply([{ name: 'USER.md', choice: 'update' }]);
      expect(results).toEqual([{ name: 'USER.md', outcome: 'updated', backupName: 'USER.md.bak-2026-09-17' }]);
      expect(read('USER.md')).toBe(current('USER.md', { userName: '老张', agentName: 'KyDog' }));
      expect(read('USER.md.bak-2026-09-17')).toBe('---\nname: "老张"\n---\n\n旧的 USER\n');
      expect((await readHarnessState(dir)).files['USER.md']).toEqual({ locale: 'zh', template: harnessTemplate('zh', 'USER.md'), keptTemplateSha: null });
      expect((await svc().status()).files[1].template).toBe('latest');
    });

    it('备份重名依次 -2、-3，已有的备份字节不变', async () => {
      await seedOldAgents();
      writeFileSync(f('AGENTS.md.bak-2026-09-17'), 'first');
      writeFileSync(f('AGENTS.md.bak-2026-09-17-2'), 'second');
      const { results } = await svc().apply([{ name: 'AGENTS.md', choice: 'update' }]);
      expect(results[0]).toEqual({ name: 'AGENTS.md', outcome: 'updated', backupName: 'AGENTS.md.bak-2026-09-17-3' });
      expect(read('AGENTS.md.bak-2026-09-17')).toBe('first');
      expect(read('AGENTS.md.bak-2026-09-17-2')).toBe('second');
      expect(read('AGENTS.md.bak-2026-09-17-3')).toBe(OLD_AGENTS);
    });

    it('备份失败 → 这一份停下：原文件字节不变、没有新文件；另一份照常更新', async () => {
      await seedOldAgents();
      writeFileSync(f('SOUL.md'), '---\nname: "狗哥"\n---\n\n旧 SOUL\n');
      const real = fsp.copyFile;
      vi.spyOn(fsp, 'copyFile').mockImplementation(async (src, dest, mode) => {
        if (String(src).endsWith('AGENTS.md')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return real(src, dest, mode);
      });
      const { results } = await svc().apply([{ name: 'AGENTS.md', choice: 'update' }, { name: 'SOUL.md', choice: 'update' }]);
      expect(results[0]).toMatchObject({ name: 'AGENTS.md', outcome: 'failed' });
      expect((results[0] as { error: string }).error).toContain('EACCES');
      expect(read('AGENTS.md')).toBe(OLD_AGENTS);
      expect(readdirSync(dir).filter((n) => n.startsWith('AGENTS.md.'))).toEqual([]);
      expect((await readHarnessState(dir)).files['AGENTS.md']?.template).toBe(OLD_AGENTS);
      expect(results[1]).toEqual({ name: 'SOUL.md', outcome: 'updated', backupName: 'SOUL.md.bak-2026-09-17' });
      expect(read('SOUL.md')).toBe(current('SOUL.md', { userName: 'You', agentName: '狗哥' }));
    });

    it('写新文件失败 → 原文件不变、备份仍在，报失败', async () => {
      await seedOldAgents();
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(Object.assign(new Error('EPERM: rename'), { code: 'EPERM' }));
      const { results } = await svc().apply([{ name: 'AGENTS.md', choice: 'update' }]);
      expect(results[0]).toMatchObject({ name: 'AGENTS.md', outcome: 'failed' });
      expect(read('AGENTS.md')).toBe(OLD_AGENTS);
      expect(read('AGENTS.md.bak-2026-09-17')).toBe(OLD_AGENTS);
      // 写失败不留半截临时文件在 ~/.kydog/ 里（目录里只剩原文件与备份）
      expect(readdirSync(dir).filter((n) => n.startsWith('AGENTS.md')).sort()).toEqual(['AGENTS.md', 'AGENTS.md.bak-2026-09-17']);
    });

    it('状态文件读不出来（不是不存在）→ 整批报错，不拿空状态写回去抹掉别的记录', async () => {
      await seedOldAgents();
      await svc().apply([{ name: 'AGENTS.md', choice: 'keep' }]);
      const before = readFileSync(path.join(dir, '.harness-state.json'), 'utf8');
      vi.spyOn(fsp, 'readFile').mockImplementation(async () => {
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      });
      await expect(svc().apply([{ name: 'SOUL.md', choice: 'keep' }])).rejects.toThrow('EBUSY');
      vi.restoreAllMocks();
      expect(readFileSync(path.join(dir, '.harness-state.json'), 'utf8')).toBe(before);
    });

    it('文件不存在 → 创建：不备份，backupName 为 null', async () => {
      locale = 'en';
      const { results } = await svc().apply([{ name: 'AGENTS.md', choice: 'update' }]);
      expect(results[0]).toEqual({ name: 'AGENTS.md', outcome: 'updated', backupName: null });
      expect(read('AGENTS.md')).toBe(current('AGENTS.md'));
      expect(readdirSync(dir).filter((n) => n.includes('.bak-'))).toEqual([]);
      expect((await readHarnessState(dir)).files['AGENTS.md']?.locale).toBe('en');
    });
  });

  describe('apply：保持', () => {
    it('有记录 → 只写 keptTemplateSha，不碰文件；下次 status 为 kept', async () => {
      await seedOldAgents();
      const { results } = await svc().apply([{ name: 'AGENTS.md', choice: 'keep' }]);
      expect(results).toEqual([{ name: 'AGENTS.md', outcome: 'kept' }]);
      expect(read('AGENTS.md')).toBe(OLD_AGENTS);
      expect((await readHarnessState(dir)).files['AGENTS.md']).toEqual({
        locale: 'zh', template: OLD_AGENTS, keptTemplateSha: templateSha(harnessTemplate('zh', 'AGENTS.md')),
      });
      expect((await svc().status()).files[2]).toMatchObject({ template: 'kept', edit: 'unchanged' });
    });

    it('老用户（无记录）→ 新建一条模板为 null 的记录；下次 kept + unknown', async () => {
      writeFileSync(f('AGENTS.md'), OLD_AGENTS);
      expect((await svc().status()).files[2]).toMatchObject({ template: 'available', edit: 'unknown' });
      await svc().apply([{ name: 'AGENTS.md', choice: 'keep' }]);
      expect((await readHarnessState(dir)).files['AGENTS.md']).toEqual({
        locale: null, template: null, keptTemplateSha: templateSha(harnessTemplate('zh', 'AGENTS.md')),
      });
      expect((await svc().status()).files[2]).toMatchObject({ template: 'kept', edit: 'unknown' });
    });

    it('选过保持后切换界面语言 → 回到 available + localeDiffers', async () => {
      await seedOldAgents();
      await svc().apply([{ name: 'AGENTS.md', choice: 'keep' }]);
      locale = 'en';
      expect((await svc().status()).files[2]).toMatchObject({ template: 'available', localeDiffers: true, templateLocale: 'en' });
    });
  });

  describe('read', () => {
    it('SOUL/USER 拆出名字与正文；AGENTS 没有头部 → 名字 null、正文是全文；不存在 → exists false', async () => {
      writeFileSync(f('USER.md'), '---\nname: "Dr. Zhang"\n---\n\n# USER\n');
      writeFileSync(f('AGENTS.md'), OLD_AGENTS);
      expect(await svc().read('USER.md')).toEqual({ exists: true, content: '---\nname: "Dr. Zhang"\n---\n\n# USER\n', frontmatterName: 'Dr. Zhang', body: '# USER' });
      expect(await svc().read('AGENTS.md')).toEqual({ exists: true, content: OLD_AGENTS, frontmatterName: null, body: OLD_AGENTS });
      expect(await svc().read('SOUL.md')).toEqual({ exists: false });
    });

    it('头部 YAML 坏了 → 名字 null、正文给整份原文', async () => {
      const broken = '---\nname: [oops\n---\n\n正文\n';
      writeFileSync(f('SOUL.md'), broken);
      expect(await svc().read('SOUL.md')).toEqual({ exists: true, content: broken, frontmatterName: null, body: broken });
    });
  });

  describe('write', () => {
    it('磁盘等于 expected → 原样写入（字节不变）', async () => {
      await seedOldAgents();
      const mine = '# 我的手册\n\n- 一条\r\n- 两条\n';
      expect(await svc().write({ name: 'AGENTS.md', content: mine, expected: OLD_AGENTS })).toEqual({ ok: true });
      expect(read('AGENTS.md')).toBe(mine);
    });

    it('磁盘已被改过 → 不写，带回磁盘现内容；拿现内容作 expected 再写就成', async () => {
      await seedOldAgents();
      writeFileSync(f('AGENTS.md'), 'agent 改的');
      expect(await svc().write({ name: 'AGENTS.md', content: '我的', expected: OLD_AGENTS })).toEqual({ ok: false, diskContent: 'agent 改的' });
      expect(read('AGENTS.md')).toBe('agent 改的');
      expect(await svc().write({ name: 'AGENTS.md', content: '我的', expected: 'agent 改的' })).toEqual({ ok: true });
      expect(read('AGENTS.md')).toBe('我的');
    });

    it('编辑期间文件被删 → 冲突，diskContent 为 null；expected 为 null 时照写', async () => {
      expect(await svc().write({ name: 'SOUL.md', content: 'x', expected: 'was here' })).toEqual({ ok: false, diskContent: null });
      expect(existsSync(f('SOUL.md'))).toBe(false);
      expect(await svc().write({ name: 'SOUL.md', content: 'x', expected: null })).toEqual({ ok: true });
      expect(read('SOUL.md')).toBe('x');
    });
  });

  it('只认三个文件名：路径、别的名字一律拒绝（三个名字本身能过）', async () => {
    await expect(svc().read('AGENTS.md')).resolves.toBeDefined();
    for (const bad of ['../kydog.json', 'kydog.json', '/etc/passwd', 'AGENTS.md.bak-2026-09-17']) {
      await expect(svc().read(bad as 'AGENTS.md')).rejects.toThrow();
      await expect(svc().write({ name: bad as 'AGENTS.md', content: 'x', expected: null })).rejects.toThrow();
      await expect(svc().apply([{ name: bad as 'AGENTS.md', choice: 'update' }])).rejects.toThrow();
    }
    expect(existsSync(path.join(dir, 'kydog.json'))).toBe(false);
  });
});
