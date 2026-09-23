import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
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
    await initProviderRegistry(settingsService, '0.0.0-test');
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
    expect(entry!.models.map((m) => m.id)).toContain('llama3.1:8b');
  });

  it('list: models[].image 按 pi 的 Model.input 算 —— 能读图的 true，只读文字的 false', async () => {
    await llmService.configure({ providerId: 'anthropic', cfg: { kind: 'apiKey', apiKey: 'k' } });
    await llmService.configure({ providerId: 'deepseek', cfg: { kind: 'apiKey', apiKey: 'k' } });
    const list = await llmService.list();
    const anthropic = list.configured.find((c) => c.providerId === 'anthropic')!;
    const deepseek = list.configured.find((c) => c.providerId === 'deepseek')!;
    expect(anthropic.models.find((m) => m.id === 'claude-sonnet-4-5')?.image).toBe(true);
    // 先证明「它在模型列表里」，再断「它不读图」：否则 deepseek-v4-flash 压根没列出来时
    // （远端目录已经把它下架了）这条也会绿。
    const flash = deepseek.models.find((m) => m.id === 'deepseek-v4-flash');
    expect(flash).toBeDefined();
    expect(flash!.image).toBe(false);
  });

  /**
   * 在 `<ROOT>/agent/models-store.json` 里种一份远端目录缓存（pi 与 KyDog 共用的那个文件），
   * 然后重建 registry 让它生效。单测里 PI_OFFLINE=1，不会有网络刷新来改写它。
   */
  const seedCatalog = async (json: unknown) => {
    mkdirSync(path.join(dir, 'agent'), { recursive: true });
    writeFileSync(path.join(dir, 'agent', 'models-store.json'), JSON.stringify(json));
    _resetProviderRegistryForTest();
    await initProviderRegistry(settingsService, '0.0.0-test');
  };
  const cachedCatalog = (providerId: string, ids: string[], extra: Record<string, unknown> = {}) => ({
    [providerId]: {
      models: ids.map((id) => ({ id, name: id, provider: providerId, input: ['text'] })),
      lastModified: Date.UTC(2026, 8, 23),
      checkedAt: Date.UTC(2026, 8, 23),
      kydogStampedWith: '0.0.0-test',
      ...extra,
    },
  });

  it('list: 远端目录拉到过之后，内置静态目录里多出来的 id 是退役的，不再列出来', async () => {
    await llmService.configure({ providerId: 'deepseek', cfg: { kind: 'apiKey', apiKey: 'k' } });
    // 先证明没有远端目录时它在：否则下面那条「不在」在任何情况下都绿（比如 id 改了名）。
    const before = (await llmService.list()).configured.find((c) => c.providerId === 'deepseek')!;
    expect(before.models.map((m) => m.id)).toContain('deepseek-v4-flash');

    await seedCatalog(cachedCatalog('deepseek', ['deepseek-v4-pro']));
    const after = (await llmService.list()).configured.find((c) => c.providerId === 'deepseek')!;
    expect(after.models.map((m) => m.id)).toContain('deepseek-v4-pro');
    expect(after.models.map((m) => m.id)).not.toContain('deepseek-v4-flash');
  });

  it('list: 缓存不是本版本 KyDog 写的 → 一个都不过滤', async () => {
    await llmService.configure({ providerId: 'deepseek', cfg: { kind: 'apiKey', apiKey: 'k' } });
    // 与上一条同一份缓存，只把写入者版本换掉 —— pi 可能已经把这份缓存当过期丢了，
    // 照它过滤会把在售模型藏起来，而且是静默的。
    await seedCatalog(cachedCatalog('deepseek', ['deepseek-v4-pro'], { kydogStampedWith: '9.9.9' }));
    const entry = (await llmService.list()).configured.find((c) => c.providerId === 'deepseek')!;
    expect(entry.models.map((m) => m.id)).toContain('deepseek-v4-flash');
  });

  it('list: 缓存里没有这个 provider 的条目 → 一个都不过滤', async () => {
    await llmService.configure({ providerId: 'deepseek', cfg: { kind: 'apiKey', apiKey: 'k' } });
    await seedCatalog(cachedCatalog('anthropic', ['claude-sonnet-4-5']));
    const entry = (await llmService.list()).configured.find((c) => c.providerId === 'deepseek')!;
    expect(entry.models.map((m) => m.id)).toContain('deepseek-v4-flash');
  });

  it('list: models[].name 来自目录，名字缺失才回落成 id', async () => {
    await llmService.configure({ providerId: 'deepseek', cfg: { kind: 'apiKey', apiKey: 'k' } });
    const deepseek = (await llmService.list()).configured.find((c) => c.providerId === 'deepseek')!;
    // 名字与 id 不是同一个串 —— 拿掉 `name` 只剩 id 时这条会红（选单就只能显示 id 了）。
    expect(deepseek.models.find((m) => m.id === 'deepseek-v4-flash')?.name).toBe('DeepSeek V4 Flash');
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
    expect(entry.models).toEqual([
      { id: 'vis', name: 'vis', image: true },
      { id: 'plain', name: 'plain', image: false },
    ]);
  });
});
