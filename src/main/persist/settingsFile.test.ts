// src/main/persist/settingsFile.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os, { tmpdir } from 'node:os';
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
  it('defaultSettings includes skills.disabledBuiltins=[]', () => {
    expect(defaultSettings().skills).toEqual({ disabledBuiltins: [] });
  });
  it('defaultSettings includes tools.externalBins=[]', () => {
    expect(defaultSettings().tools).toEqual({ externalBins: [] });
  });
  it('loadSettings normalizes legacy file missing skills field', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'kydog-set-'));
    const file = path.join(dir2, 'kydog.json');
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false },
      llm: { provider: null },
    }));
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(file);
    const loaded = await loadSettings();
    expect(loaded.skills).toEqual({ disabledBuiltins: [] });
  });
  it('loadSettings normalizes legacy file missing tools field', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'kydog-tools-'));
    const file = path.join(dir2, 'kydog.json');
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false },
      llm: { provider: null },
      skills: { disabledBuiltins: [] },
    }));
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(file);
    const loaded = await loadSettings();
    expect(loaded.tools).toEqual({ externalBins: [] });
  });
});
