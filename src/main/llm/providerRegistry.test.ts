import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { SettingsService } from '../settings/settingsService';
import { ProviderRegistry, buildModelRuntimeOptions } from './providerRegistry';

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

  it('build: 空 settings → registry 可用', async () => {
    const reg = await ProviderRegistry.build(svc);
    expect(reg.modelRuntime).toBeDefined();
  });

  it('build: customProviders 注册到 modelRuntime', async () => {
    await svc.update({ llm: {
      ...(await svc.get()).llm,
      customProviders: [{
        id: 'ollama-x', displayName: 'Ollama', baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions', apiKey: 'ollama',
        models: [{ id: 'llama3.1:8b' }],
      }],
    } });
    const reg = await ProviderRegistry.build(svc);
    const found = reg.modelRuntime.getModel('ollama-x', 'llama3.1:8b');
    expect(found).toBeDefined();
  });

  it('refreshAfterProviderChange: 重建 modelRuntime', async () => {
    const reg = await ProviderRegistry.build(svc);
    const before = reg.modelRuntime;
    await svc.update({ llm: {
      ...(await svc.get()).llm,
      customProviders: [{
        id: 'new-cp', displayName: 'X', baseUrl: 'http://x', api: 'openai-completions',
        apiKey: 'k', models: [{ id: 'm' }],
      }],
    } });
    const fakeAgent = { invalidateSessionsForProviders: vi.fn().mockResolvedValue(undefined) };
    await reg.refreshAfterProviderChange(svc, fakeAgent as any, ['new-cp']);
    expect(reg.modelRuntime).not.toBe(before);
    expect(fakeAgent.invalidateSessionsForProviders).toHaveBeenCalledWith(['new-cp']);
    expect(reg.modelRuntime.getModel('new-cp', 'm')).toBeDefined();
  });

  // 守 f96afc7 的成果：不传 modelsPath 时 pi 默认写 ~/.pi/agent/models-store.json，
  // 等于把刚拆掉的耦合重建出来。选项抽成纯函数才能确定性地断言，不依赖真实 home。
  it('modelsPath 落在 <ROOT>/agent 下，不碰 ~/.pi', () => {
    const opts = buildModelRuntimeOptions(svc);
    expect(opts.modelsPath).toBe(path.join(dir, 'agent', 'models.json'));
    expect(opts.modelsPath.split(path.sep)).not.toContain('.pi');
  });

  it('allowModelNetwork 打开，否则拿不到远程模型目录', () => {
    expect(buildModelRuntimeOptions(svc).allowModelNetwork).toBe(true);
  });
});
