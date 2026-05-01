import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { saveIndex } from '../persist/indexFile';
import { settingsService } from '../settings/settingsService';
import { llmService } from './llmService';
import { initProviderRegistry, _resetProviderRegistryForTest } from './providerRegistry';

describe('llmService', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-llm-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    ensureSettingsFile();
    await saveIndex({ schemaVersion: 1, projects: [{ path: dir, addedAt: new Date().toISOString() }], threads: [] });
    (settingsService as any).cache = null;
    _resetProviderRegistryForTest();
    await initProviderRegistry(settingsService);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('list: 空 settings → catalog 23 行 + configured 空', async () => {
    const r = await llmService.list();
    expect(r.catalog.length).toBe(23);
    expect(r.configured).toEqual([]);
    expect(r.defaultProvider).toBeNull();
  });

  it('configure(apiKey): 写 auth blob + providers entry + reloadAuth', async () => {
    await llmService.configure({
      providerId: 'anthropic',
      cfg: { kind: 'apiKey', apiKey: 'sk-ant-1', baseUrl: 'https://x.example' },
    });
    const s = await settingsService.get();
    expect(s.llm.auth['anthropic']).toEqual({ type: 'api_key', key: 'sk-ant-1' });
    expect(s.llm.providers['anthropic']?.baseUrl).toBe('https://x.example');
    const list = await llmService.list();
    expect(list.configured.find((c) => c.providerId === 'anthropic')).toBeDefined();
  });

  it('setDefault: 写入 + recomputeSessions 调用', async () => {
    await llmService.configure({ providerId: 'anthropic', cfg: { kind: 'apiKey', apiKey: 'k' } });
    await llmService.setDefault('anthropic', 'claude-sonnet-4-5');
    const s = await settingsService.get();
    expect(s.llm.defaultProvider).toBe('anthropic');
    expect(s.llm.defaultModel).toBe('claude-sonnet-4-5');
  });

  it('remove: 清 auth + providers + 级联清空全局 default', async () => {
    await llmService.configure({ providerId: 'anthropic', cfg: { kind: 'apiKey', apiKey: 'k' } });
    await llmService.setDefault('anthropic', 'claude-sonnet-4-5');
    await llmService.remove('anthropic');
    const s = await settingsService.get();
    expect(s.llm.auth['anthropic']).toBeUndefined();
    expect(s.llm.providers['anthropic']).toBeUndefined();
    expect(s.llm.defaultProvider).toBeNull();
    expect(s.llm.defaultModel).toBeNull();
  });

  it('setThreadOverride: 写 + 清', async () => {
    const { threadService } = await import('../thread/threadService');
    const t = await threadService.create({ projectPath: dir, title: 'x' });
    await llmService.setThreadOverride(t.id, { providerId: 'anthropic', modelId: 'claude' });
    const updated = (await threadService.listAll()).find((x) => x.id === t.id);
    expect(updated?.modelOverride).toEqual({ providerId: 'anthropic', modelId: 'claude' });
    await llmService.setThreadOverride(t.id, null);
    const cleared = (await threadService.listAll()).find((x) => x.id === t.id);
    expect(cleared?.modelOverride).toBeUndefined();
  });

  it('configure(custom): registerProvider 使新 provider 可见', async () => {
    await llmService.configure({
      providerId: 'ollama-local',
      cfg: { kind: 'custom', provider: {
        id: 'ollama-local', displayName: 'Ollama', baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions', apiKey: 'ollama',
        models: [{ id: 'llama3.1:8b' }],
      } },
    });
    const list = await llmService.list();
    const entry = list.configured.find((c) => c.providerId === 'ollama-local');
    expect(entry).toBeDefined();
    expect(entry!.modelIds).toContain('llama3.1:8b');
  });
});
