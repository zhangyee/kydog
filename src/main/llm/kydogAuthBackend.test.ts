import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { SettingsService } from '../settings/settingsService';
import { KydogCredentialStore } from './kydogAuthBackend';

describe('KydogCredentialStore', () => {
  let dir: string;
  let svc: SettingsService;
  let store: KydogCredentialStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-cred-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    ensureSettingsFile();
    svc = new SettingsService();
    store = new KydogCredentialStore(svc);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('read: 不存在的 provider 返回 undefined', async () => {
    expect(await store.read('anthropic')).toBeUndefined();
  });

  it('modify: 写入后 read 能读到，且真的落到磁盘上的 kydog.json', async () => {
    const written = await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-1' }));
    expect(written).toEqual({ type: 'api_key', key: 'sk-1' });
    expect(await store.read('anthropic')).toEqual({ type: 'api_key', key: 'sk-1' });
    expect((await svc.get()).llm.auth.anthropic).toEqual({ type: 'api_key', key: 'sk-1' });
    // 上面三条都只证明内存 cache 是对的（svc.get() 返回的就是 cache）。这个模块存在的
    // 唯一理由是把凭证持久化，所以直接读回磁盘 —— 只热 cache 不落盘的实现要在这里挂掉。
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'kydog.json'), 'utf8'));
    expect(onDisk.llm.auth.anthropic).toEqual({ type: 'api_key', key: 'sk-1' });
  });

  it('modify: fn 能看到当前值（refresh 场景依赖它）', async () => {
    await store.modify('anthropic', async () => ({ type: 'oauth', refresh: 'r1', access: 'a1', expires: 1 }));
    let seen: unknown;
    await store.modify('anthropic', async (current) => {
      seen = current;
      return { type: 'oauth', refresh: 'r2', access: 'a2', expires: 2 };
    });
    expect(seen).toEqual({ type: 'oauth', refresh: 'r1', access: 'a1', expires: 1 });
    expect(await store.read('anthropic')).toEqual({ type: 'oauth', refresh: 'r2', access: 'a2', expires: 2 });
  });

  it('modify: fn 返回 undefined 时保持原值不变', async () => {
    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-1' }));
    const result = await store.modify('anthropic', async () => undefined);
    expect(result).toEqual({ type: 'api_key', key: 'sk-1' });
    expect(await store.read('anthropic')).toEqual({ type: 'api_key', key: 'sk-1' });
  });

  it('list: 只返回 providerId + type，不含密钥', async () => {
    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-secret' }));
    await store.modify('openai', async () => ({ type: 'oauth', refresh: 'r', access: 'a', expires: 0 }));
    const infos = await store.list();
    expect(infos).toHaveLength(2);
    expect(infos).toContainEqual({ providerId: 'anthropic', type: 'api_key' });
    expect(infos).toContainEqual({ providerId: 'openai', type: 'oauth' });
    expect(JSON.stringify(infos)).not.toContain('sk-secret');
  });

  it('delete: 移除条目', async () => {
    await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-1' }));
    await store.delete('anthropic');
    expect(await store.read('anthropic')).toBeUndefined();
    expect((await svc.get()).llm.auth.anthropic).toBeUndefined();
  });

  it('delete: 不存在的 provider 不抛错', async () => {
    await expect(store.delete('nope')).resolves.toBeUndefined();
  });

  it('modify: 同一 provider 的并发写不交错，每个 fn 都看得到上一次的结果', async () => {
    // 这是 CredentialStore 文档注释里那条不变式：pi 的 OAuth refresh 就跑在 modify 的
    // fn 内部，同 provider 的读-改-写一旦交错就会双刷 / 丢掉刚轮换的 token。
    // （跨 provider 的串行化是 SettingsService 全局队列的事，settingsService.test.ts
    // 已经用 N=100 覆盖，这里不重复测那一层。）
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.modify('anthropic', async (current) => {
          // 读到 current 后强行 await 一次，制造交错窗口。
          await new Promise((r) => setTimeout(r, 1));
          const prev = current?.type === 'api_key' ? (current.key ?? '') : '';
          return { type: 'api_key', key: `${prev}${i}` };
        }),
      ),
    );
    const final = await store.read('anthropic');
    expect(final?.type).toBe('api_key');
    // 5 次追加全部落地才有 5 个字符；任何一次交错都会覆盖掉别人的写入，长度变短。
    expect((final as { key: string }).key).toHaveLength(5);
  });
});
