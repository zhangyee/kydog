import { describe, it, expect, vi } from 'vitest';
import { SettingsService } from './settingsService';
import { defaultSettings } from '../persist/settingsFile';
import type { SettingsFile } from '../../shared/types';

function makeService() {
  const base = defaultSettings();
  const load = vi.fn().mockResolvedValue(structuredClone(base)) as () => Promise<SettingsFile>;
  const save = vi.fn().mockResolvedValue(undefined) as (s: SettingsFile) => Promise<void>;
  const svc = new SettingsService(load, save);
  return { svc, load, save, base };
}

describe('SettingsService', () => {
  it('get() calls load once and caches', async () => {
    const { svc, load } = makeService();
    await svc.get();
    await svc.get();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('update deep-merges ui with new values, preserves untouched keys', async () => {
    const { svc } = makeService();
    const result = await svc.update({ ui: { theme: 'midnight', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false } });
    expect(result.ui.theme).toBe('midnight');
    expect(result.ui.locale).toBe('zh');
  });

  it('update deep-merges llm with new values', async () => {
    const { svc } = makeService();
    const provider = { kind: 'openai-compat' as const, name: 'T', baseUrl: 'http://localhost', apiKey: 'k', model: 'm' };
    const result = await svc.update({ llm: { provider } });
    expect(result.llm.provider).toEqual(provider);
  });

  it('update calls save with the merged object', async () => {
    const { svc, save } = makeService();
    const result = await svc.update({ ui: { theme: 'midnight', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false } });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(result);
  });

  it('update honors false values (inspectorCollapsed: false preserved)', async () => {
    const { svc } = makeService();
    // First set to true
    await svc.update({ ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: true } });
    // Then set back to false
    const result = await svc.update({ ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false } });
    expect(result.ui.inspectorCollapsed).toBe(false);
  });

  it('update({skills: {disabledBuiltins:["x"]}}) does not affect ui or llm', async () => {
    const fakeLoad = async (): Promise<SettingsFile> => ({
      schemaVersion: 1,
      ui: { theme: 'sepia', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false },
      llm: { provider: { kind: 'openai-compat', name: 'p', baseUrl: 'u', apiKey: 'k', model: 'm' } },
      skills: { disabledBuiltins: [] },
    });
    const savedRef: { value: SettingsFile | null } = { value: null };
    const svc = new SettingsService(fakeLoad, async (s) => { savedRef.value = s; });
    await svc.update({ skills: { disabledBuiltins: ['x'] } });
    expect(savedRef.value?.skills.disabledBuiltins).toEqual(['x']);
    expect(savedRef.value?.ui.theme).toBe('sepia');
    expect(savedRef.value?.llm.provider?.name).toBe('p');
  });

  it('reset calls save with defaultSettings and clears cache', async () => {
    const { svc, save, load } = makeService();
    // Prime the cache
    await svc.get();
    expect(load).toHaveBeenCalledTimes(1);
    await svc.reset();
    expect(save).toHaveBeenCalledWith(defaultSettings());
    // After reset, next get should use the reset cache (not call load again)
    await svc.get();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
