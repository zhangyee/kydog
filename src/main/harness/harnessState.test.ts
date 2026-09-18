import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHarnessState, writeHarnessState, withHarnessLock, HARNESS_STATE_FILE } from './harnessState';

describe('harnessState', () => {
  let dir: string;
  const file = () => path.join(dir, HARNESS_STATE_FILE);
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-hstate-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('没有文件 → 空记录；写进去再读回来一致', async () => {
    expect(await readHarnessState(dir)).toEqual({ schemaVersion: 1, files: {} });
    const s = { schemaVersion: 1 as const, files: { 'AGENTS.md': { locale: 'zh' as const, template: 'T', keptTemplateSha: null } } };
    await writeHarnessState(s, dir);
    expect(await readHarnessState(dir)).toEqual(s);
  });

  it.skipIf(process.platform === 'win32')('落盘权限 0600', async () => {
    await writeHarnessState({ schemaVersion: 1, files: {} }, dir);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });

  it('老用户选过保持的记录（template / locale 为 null）是合法的', async () => {
    const s = { schemaVersion: 1 as const, files: { 'USER.md': { locale: null, template: null, keptTemplateSha: 'a'.repeat(64) } } };
    await writeHarnessState(s, dir);
    expect(await readHarnessState(dir)).toEqual(s);
  });

  it.each([
    ['不是 JSON', '{oops'],
    ['版本不认识', JSON.stringify({ schemaVersion: 2, files: {} })],
    ['文件名不认识', JSON.stringify({ schemaVersion: 1, files: { 'EVIL.md': { locale: 'zh', template: 'T', keptTemplateSha: null } } })],
    ['locale 取值不对', JSON.stringify({ schemaVersion: 1, files: { 'AGENTS.md': { locale: 'fr', template: 'T', keptTemplateSha: null } } })],
    ['template 与 locale 一个 null 一个不是', JSON.stringify({ schemaVersion: 1, files: { 'AGENTS.md': { locale: 'zh', template: null, keptTemplateSha: null } } })],
    ['keptTemplateSha 不是字符串', JSON.stringify({ schemaVersion: 1, files: { 'AGENTS.md': { locale: 'zh', template: 'T', keptTemplateSha: 1 } } })],
  ])('结构不合（%s）→ 改名成 .bad、按没有记录处理', async (_why, raw) => {
    writeFileSync(file(), raw);
    expect(await readHarnessState(dir)).toEqual({ schemaVersion: 1, files: {} });
    expect(existsSync(file())).toBe(false);
    expect(readFileSync(file() + '.bad', 'utf8')).toBe(raw);
  });

  it('withHarnessLock：前一个没完，后一个不开始；前一个完了，后一个接着跑，两次改动都落盘', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const a = withHarnessLock(async () => {
      order.push('a:start');
      const s = await readHarnessState(dir);
      await gate;                                    // a 读完、还没写 —— 没有队列的话 b 这时读到的也是空的
      s.files['SOUL.md'] = { locale: 'zh', template: 'S', keptTemplateSha: null };
      await writeHarnessState(s, dir);
      order.push('a:end');
    });
    const b = withHarnessLock(async () => {
      order.push('b:start');
      const s = await readHarnessState(dir);
      s.files['USER.md'] = { locale: 'zh', template: 'U', keptTemplateSha: null };
      await writeHarnessState(s, dir);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['a:start']);              // b 被挡在后面
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    expect(Object.keys((await readHarnessState(dir)).files).sort()).toEqual(['SOUL.md', 'USER.md']);
  });

  it('withHarnessLock：前一个抛错不堵死队列', async () => {
    await expect(withHarnessLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withHarnessLock(async () => 42)).toBe(42);
  });
});
