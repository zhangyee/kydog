import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { SettingsService } from '../settings/settingsService';
import { ProviderRegistry } from './providerRegistry';

describe('ProviderRegistry', () => {
  let dir: string;
  let svc: SettingsService;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-reg-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    ensureSettingsFile();
    svc = new SettingsService();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('build: 空 settings → registry 可用，authStorage 唯一', async () => {
    const reg = await ProviderRegistry.build(svc);
    expect(reg.authStorage).toBeDefined();
    expect(reg.modelRegistry).toBeDefined();
  });

  it('build: customProviders 注册到 modelRegistry', async () => {
    await svc.update({ llm: {
      ...(await svc.get()).llm,
      customProviders: [{
        id: 'ollama-x', displayName: 'Ollama', baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions', apiKey: 'ollama',
        models: [{ id: 'llama3.1:8b' }],
      }],
    } });
    const reg = await ProviderRegistry.build(svc);
    const found = reg.modelRegistry.find('ollama-x', 'llama3.1:8b');
    expect(found).toBeDefined();
  });

  it('refreshAfterProviderChange: 重建 modelRegistry', async () => {
    const reg = await ProviderRegistry.build(svc);
    const before = reg.modelRegistry;
    await svc.update({ llm: {
      ...(await svc.get()).llm,
      customProviders: [{
        id: 'new-cp', displayName: 'X', baseUrl: 'http://x', api: 'openai-completions',
        apiKey: 'k', models: [{ id: 'm' }],
      }],
    } });
    const fakeAgent = { invalidateSessionsForProviders: vi.fn().mockResolvedValue(undefined) };
    await reg.refreshAfterProviderChange(svc, fakeAgent as any, ['new-cp']);
    expect(reg.modelRegistry).not.toBe(before);
    expect(fakeAgent.invalidateSessionsForProviders).toHaveBeenCalledWith(['new-cp']);
    expect(reg.modelRegistry.find('new-cp', 'm')).toBeDefined();
  });

  it('reloadAuth: 不抛错（pi 内部刷新缓存）', async () => {
    const reg = await ProviderRegistry.build(svc);
    expect(() => reg.reloadAuth()).not.toThrow();
  });
});
