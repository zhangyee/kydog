import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { settingsService } from '../settings/settingsService';
import { resolveActive, ResolveError } from './resolveActive';

describe('resolveActive', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-resolve-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    ensureSettingsFile();
    (settingsService as any).cache = null;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('thread.modelOverride 存在 → 直接返回', async () => {
    const threadStore = { get: vi.fn().mockResolvedValue({ id: 't1', modelOverride: { providerId: 'openai', modelId: 'gpt-4o' } }) };
    const r = await resolveActive('t1', '/x', threadStore as any);
    expect(r).toEqual({ providerId: 'openai', modelId: 'gpt-4o' });
  });

  it('无 override → 用 providers[id].defaultModel', async () => {
    await settingsService.update({ llm: {
      ...(await settingsService.get()).llm,
      defaultProvider: 'anthropic',
      defaultModel: null,
      providers: { anthropic: { defaultModel: 'claude-sonnet-4-5' } },
    } });
    const threadStore = { get: vi.fn().mockResolvedValue({ id: 't1' }) };
    const r = await resolveActive('t1', '/x', threadStore as any);
    expect(r).toEqual({ providerId: 'anthropic', modelId: 'claude-sonnet-4-5' });
  });

  it('无 override + 无 provider 默认 → 落全局 defaultModel', async () => {
    await settingsService.update({ llm: {
      ...(await settingsService.get()).llm,
      defaultProvider: 'anthropic',
      defaultModel: 'claude-haiku',
      providers: { anthropic: {} },
    } });
    const threadStore = { get: vi.fn().mockResolvedValue({ id: 't1' }) };
    const r = await resolveActive('t1', '/x', threadStore as any);
    expect(r.modelId).toBe('claude-haiku');
  });

  it('无 defaultProvider → 抛 ResolveError "no provider"', async () => {
    const threadStore = { get: vi.fn().mockResolvedValue({ id: 't1' }) };
    await expect(resolveActive('t1', '/x', threadStore as any)).rejects.toThrow(ResolveError);
  });

  it('有 defaultProvider 但 providers + 全局 defaultModel 都为空 → 抛 ResolveError "no model"', async () => {
    await settingsService.update({ llm: { ...(await settingsService.get()).llm, defaultProvider: 'anthropic' } });
    const threadStore = { get: vi.fn().mockResolvedValue({ id: 't1' }) };
    await expect(resolveActive('t1', '/x', threadStore as any)).rejects.toThrow(/no model/);
  });
});
