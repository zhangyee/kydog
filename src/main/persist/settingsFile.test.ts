// src/main/persist/settingsFile.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as paths from './paths';
import { loadSettings, saveSettings, defaultSettings } from './settingsFile';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-'));
  vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('settingsFile', () => {
  it('returns default with provider null when missing', async () => {
    const s = await loadSettings();
    expect(s).toEqual(defaultSettings());
    expect(s.llm.provider).toBeNull();
  });
  it('round-trips', async () => {
    const v = { ...defaultSettings(), llm: { provider: { kind: 'openai-compat' as const, name: 'D', baseUrl: 'u', apiKey: 'k', model: 'm' } } };
    await saveSettings(v);
    expect(await loadSettings()).toEqual(v);
  });
});
