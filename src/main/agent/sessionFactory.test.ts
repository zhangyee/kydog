import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureSettingsFile } from '../persist/settingsFile';
import { settingsService } from '../settings/settingsService';
import { _resetProviderRegistryForTest, initProviderRegistry } from '../llm/providerRegistry';
import { createSession } from './sessionFactory';

describe('sessionFactory', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-sf-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    ensureSettingsFile();
    (settingsService as any).cache = null;
    _resetProviderRegistryForTest();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('fixture path（KYDOG_AGENT_FIXTURE）走 fixture session', async () => {
    const fixtureDir = path.join(dir, '__fixtures__');
    mkdirSync(fixtureDir, { recursive: true });
    const fixturePath = path.join(fixtureDir, 'noop.json');
    writeFileSync(fixturePath, JSON.stringify({ events: [] }));
    process.env.KYDOG_AGENT_FIXTURE = fixturePath;
    try {
      const session = await createSession({
        cwd: dir, sessionId: 't1', sessionsDir: dir,
        providerId: 'anthropic', modelId: 'claude',
      });
      expect(session).toBeDefined();
    } finally {
      delete process.env.KYDOG_AGENT_FIXTURE;
    }
  });

  it('真实路径：未初始化 ProviderRegistry → 抛错', async () => {
    delete process.env.KYDOG_AGENT_FIXTURE;
    await expect(createSession({
      cwd: dir, sessionId: 't1', sessionsDir: dir,
      providerId: 'anthropic', modelId: 'claude-sonnet-4-5',
    })).rejects.toThrow();
  });

  it('真实路径：找不到 model → KydogError llm.invalid', async () => {
    delete process.env.KYDOG_AGENT_FIXTURE;
    await initProviderRegistry(settingsService);
    await expect(createSession({
      cwd: dir, sessionId: 't1', sessionsDir: dir,
      providerId: 'anthropic', modelId: 'unknown-model-xx',
    })).rejects.toThrow(/model not found/);
  });
});
