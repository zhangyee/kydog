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

  it('list: 空 settings → catalog 20 行 + configured 空', async () => {
    const r = await llmService.list();
    expect(r.catalog.length).toBe(20);
    expect(r.configured).toEqual([]);
    expect(r.defaultProvider).toBeNull();
  });

  it('configure(apiKey): 写 auth blob + providers entry + 出现在 configured 列表', async () => {
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

  it('list: imageInputModelIds 按 pi 的 Model.input 算 —— 能读图的进，只读文字的不进', async () => {
    await llmService.configure({ providerId: 'anthropic', cfg: { kind: 'apiKey', apiKey: 'k' } });
    await llmService.configure({ providerId: 'deepseek', cfg: { kind: 'apiKey', apiKey: 'k' } });
    const list = await llmService.list();
    const anthropic = list.configured.find((c) => c.providerId === 'anthropic')!;
    const deepseek = list.configured.find((c) => c.providerId === 'deepseek')!;
    expect(anthropic.imageInputModelIds).toContain('claude-sonnet-4-5');
    // 反面先证明「它在模型列表里」，再断「它不在能读图的列表里」：
    // 否则 deepseek-v4-flash 压根没列出来时这条也会绿。
    expect(deepseek.modelIds).toContain('deepseek-v4-flash');
    expect(deepseek.imageInputModelIds).not.toContain('deepseek-v4-flash');
    expect(anthropic.imageInputModelIds.every((id) => anthropic.modelIds.includes(id))).toBe(true);
  });

  it('list: 自定义服务商按 models[].input 算，没写 input 的按 [\'text\']（与 providerRegistry 同一个缺省）', async () => {
    await llmService.configure({
      providerId: 'my-vl',
      cfg: { kind: 'custom', provider: {
        id: 'my-vl', displayName: 'VL', baseUrl: 'http://localhost:1/v1',
        api: 'openai-completions', apiKey: 'k',
        models: [{ id: 'vis', input: ['text', 'image'] }, { id: 'plain' }],
      } },
    });
    const entry = (await llmService.list()).configured.find((c) => c.providerId === 'my-vl')!;
    expect(entry.modelIds).toEqual(['vis', 'plain']);
    expect(entry.imageInputModelIds).toEqual(['vis']);
  });
});
