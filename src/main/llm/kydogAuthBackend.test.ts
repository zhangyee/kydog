import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

  it('modify: 写入后 read 能读到，且落到 settings.llm.auth', async () => {
    const written = await store.modify('anthropic', async () => ({ type: 'api_key', key: 'sk-1' }));
    expect(written).toEqual({ type: 'api_key', key: 'sk-1' });
    expect(await store.read('anthropic')).toEqual({ type: 'api_key', key: 'sk-1' });
    expect((await svc.get()).llm.auth.anthropic).toEqual({ type: 'api_key', key: 'sk-1' });
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

  it('modify: 并发调用被串行化，不丢更新', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.modify(`p${i}`, async () => ({ type: 'api_key', key: `k${i}` })),
      ),
    );
    const auth = (await svc.get()).llm.auth;
    expect(Object.keys(auth).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
  });
});
