import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, statSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from './paths';
import { ensureSettingsFile, loadSettings, defaultSettings } from './settingsFile';

describe('settingsFile v3', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-settings-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('defaultSettings: schemaVersion=3 + 空 llm + readingFontSize=medium', () => {
    const d = defaultSettings();
    expect(d.schemaVersion).toBe(3);
    expect(d.ui.readingFontSize).toBe('medium');
    expect(d.llm.auth).toEqual({});
    expect(d.llm.providers).toEqual({});
    expect(d.llm.customProviders).toEqual([]);
    expect(d.llm.defaultProvider).toBeNull();
    expect(d.llm.defaultModel).toBeNull();
  });

  it('ensureSettingsFile: 创建 ~/.kydog (0700) + kydog.json (0600) v3', () => {
    ensureSettingsFile();
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(dir, 'kydog.json')).mode & 0o777).toBe(0o600);
    }
    const content = readFileSync(path.join(dir, 'kydog.json'), 'utf8');
    expect(JSON.parse(content).schemaVersion).toBe(3);
  });

  it('ensureSettingsFile: 已存在文件不覆盖', async () => {
    ensureSettingsFile();
    await fsp.writeFile(path.join(dir, 'kydog.json'), '{"sentinel":1}');
    ensureSettingsFile();
    const content = readFileSync(path.join(dir, 'kydog.json'), 'utf8');
    expect(content).toBe('{"sentinel":1}');
  });

  it('loadSettings: v1 → v3 reset (保留 ui/skills/tools，重置 llm)', async () => {
    ensureSettingsFile();
    const v1 = {
      schemaVersion: 1,
      ui: { theme: 'midnight', locale: 'zh', workspaceCollapsed: true, inspectorCollapsed: false },
      llm: { provider: { kind: 'openai-compat', name: 'OpenAI', baseUrl: 'x', apiKey: 'k', model: 'm' } },
      skills: { disabledBuiltins: ['old'] },
      tools: { externalBins: [] },
    };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v1));
    const next = await loadSettings();
    expect(next.schemaVersion).toBe(3);
    expect(next.ui.theme).toBe('midnight');
    expect(next.ui.readingFontSize).toBe('medium');
    expect(next.skills.disabledBuiltins).toEqual(['old']);
    expect(next.llm.auth).toEqual({});
    expect(next.llm.providers).toEqual({});
  });

  it('loadSettings: v2 → v3（保留所有字段，补 readingFontSize=medium）', async () => {
    ensureSettingsFile();
    const v2 = {
      schemaVersion: 2,
      ui: { theme: 'midnight', locale: 'zh', workspaceCollapsed: true, inspectorCollapsed: false },
      llm: {
        auth: { 'anthropic': { type: 'api_key', key: 'sk-x' } },
        providers: { 'anthropic': {} },
        customProviders: [],
        defaultProvider: 'anthropic',
        defaultModel: 'claude-sonnet-4-5',
      },
      skills: { disabledBuiltins: ['old'] },
      tools: { externalBins: [] },
    };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v2));
    const next = await loadSettings();
    expect(next.schemaVersion).toBe(3);
    expect(next.ui.theme).toBe('midnight');
    expect(next.ui.readingFontSize).toBe('medium');
    expect(next.llm.defaultProvider).toBe('anthropic');
    expect(next.skills.disabledBuiltins).toEqual(['old']);
  });

  it('loadSettings: v3 → v3（passthrough，保留 readingFontSize=large）', async () => {
    ensureSettingsFile();
    const v3 = defaultSettings();
    v3.ui.readingFontSize = 'large';
    v3.ui.theme = 'sepia';
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v3));
    const next = await loadSettings();
    expect(next.schemaVersion).toBe(3);
    expect(next.ui.readingFontSize).toBe('large');
    expect(next.ui.theme).toBe('sepia');
  });

  it('loadSettings: 文件权限放宽 → warn + 修正回 0600', async () => {
    if (process.platform === 'win32') return;
    ensureSettingsFile();
    await fsp.chmod(path.join(dir, 'kydog.json'), 0o644);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await loadSettings();
    expect(statSync(path.join(dir, 'kydog.json')).mode & 0o777).toBe(0o600);
    warn.mockRestore();
  });
});
