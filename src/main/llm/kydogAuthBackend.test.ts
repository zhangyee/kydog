import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { SettingsService } from '../settings/settingsService';
import { KydogAuthStorageBackend } from './kydogAuthBackend';

describe('KydogAuthStorageBackend', () => {
  let dir: string;
  let svc: SettingsService;
  let backend: KydogAuthStorageBackend;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-auth-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    ensureSettingsFile();
    svc = new SettingsService();
    backend = new KydogAuthStorageBackend(svc);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('withLock (sync): 写入 auth blob 持久化到 kydog.json', () => {
    backend.withLock((cur) => {
      const blob = cur ? JSON.parse(cur) : {};
      blob['anthropic'] = { type: 'api_key', key: 'sk-ant-1' };
      return { result: undefined, next: JSON.stringify(blob) };
    });
    return svc.get().then((s) => {
      expect(s.llm.auth['anthropic']).toEqual({ type: 'api_key', key: 'sk-ant-1' });
    });
  });

  it('withLockAsync: 写入 + 异步路径读到', async () => {
    await backend.withLockAsync(async (cur) => {
      const blob = cur ? JSON.parse(cur) : {};
      blob['openai'] = { type: 'api_key', key: 'sk-2' };
      return { result: undefined, next: JSON.stringify(blob) };
    });
    const s = await svc.get();
    expect(s.llm.auth['openai']).toEqual({ type: 'api_key', key: 'sk-2' });
  });

  it('next === current → 不写盘', () => {
    let writeCount = 0;
    const orig = svc.withLockSync.bind(svc);
    vi.spyOn(svc, 'withLockSync').mockImplementation((fn) => orig((cur) => {
      const r = fn(cur);
      if (r.next && r.next !== cur) writeCount++;
      return r;
    }));
    backend.withLock(() => ({ result: undefined }));     // 不返回 next
    expect(writeCount).toBe(0);
  });

  it('JSON 解析失败 → 抛错由调用者处理（不静默）', () => {
    expect(() => backend.withLock(() => ({
      result: undefined,
      next: 'not-json',
    }))).toThrow();
  });
});
