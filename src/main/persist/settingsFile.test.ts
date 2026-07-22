import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, statSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from './paths';
import { ensureSettingsFile, loadSettings, defaultSettings } from './settingsFile';

describe('settingsFile v4', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-settings-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('defaultSettings: schemaVersion=4 + 空 llm + readingFontSize=medium', () => {
    const d = defaultSettings();
    expect(d.schemaVersion).toBe(4);
    expect(d.ui.readingFontSize).toBe('medium');
    expect(d.llm.auth).toEqual({});
    expect(d.llm.providers).toEqual({});
    expect(d.llm.customProviders).toEqual([]);
    expect(d.llm.defaultProvider).toBeNull();
    expect(d.llm.defaultModel).toBeNull();
  });

  it('ensureSettingsFile: 创建 ~/.kydog (0700) + kydog.json (0600) v4', () => {
    ensureSettingsFile();
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(dir, 'kydog.json')).mode & 0o777).toBe(0o600);
    }
    const content = readFileSync(path.join(dir, 'kydog.json'), 'utf8');
    expect(JSON.parse(content).schemaVersion).toBe(4);
  });

  it('ensureSettingsFile: 已存在文件不覆盖', async () => {
    ensureSettingsFile();
    await fsp.writeFile(path.join(dir, 'kydog.json'), '{"sentinel":1}');
    ensureSettingsFile();
    const content = readFileSync(path.join(dir, 'kydog.json'), 'utf8');
    expect(content).toBe('{"sentinel":1}');
  });

  it('loadSettings: v1 → v4 reset (保留 ui/skills/tools，重置 llm)', async () => {
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
    expect(next.schemaVersion).toBe(4);
    expect(next.ui.theme).toBe('midnight');
    expect(next.ui.readingFontSize).toBe('medium');
    expect(next.skills.disabledBuiltins).toEqual(['old']);
    expect(next.llm.auth).toEqual({});
    expect(next.llm.providers).toEqual({});
  });

  it('loadSettings: v2 → v4（保留所有字段，补 readingFontSize=medium）', async () => {
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
    expect(next.schemaVersion).toBe(4);
    expect(next.ui.theme).toBe('midnight');
    expect(next.ui.readingFontSize).toBe('medium');
    expect(next.llm.defaultProvider).toBe('anthropic');
    expect(next.skills.disabledBuiltins).toEqual(['old']);
  });

  it('loadSettings: v3 → v4（passthrough，保留 readingFontSize=large）', async () => {
    ensureSettingsFile();
    const v3 = defaultSettings();
    v3.ui.readingFontSize = 'large';
    v3.ui.theme = 'sepia';
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v3));
    const next = await loadSettings();
    expect(next.schemaVersion).toBe(4);
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

  it('defaultSettings: schemaVersion=4 + onboarding.completedAt=null', () => {
    const d = defaultSettings();
    expect(d.schemaVersion).toBe(4);
    expect(d.onboarding).toEqual({ completedAt: null });
    expect(d.ui.locale).toBe('zh');
  });

  it('loadSettings: v3 → v4 补 onboarding，保留其余字段', async () => {
    ensureSettingsFile();
    const v3 = {
      schemaVersion: 3,
      ui: { theme: 'midnight', locale: 'zh', workspaceCollapsed: true, inspectorCollapsed: false, readingFontSize: 'large' },
      llm: { auth: { a: 1 }, providers: {}, customProviders: [], defaultProvider: 'anthropic', defaultModel: 'm1' },
      skills: { disabledBuiltins: ['x'] },
      tools: { externalBins: [] },
    };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v3));
    const s = await loadSettings();
    expect(s.schemaVersion).toBe(4);
    expect(s.onboarding).toEqual({ completedAt: null });
    expect(s.ui.theme).toBe('midnight');
    expect(s.llm.defaultProvider).toBe('anthropic');
  });

  it('loadSettings: v3 → v4 迁移时 ui.locale=\'en\' 保留', async () => {
    ensureSettingsFile();
    const v3 = {
      schemaVersion: 3,
      ui: { theme: 'midnight', locale: 'en', workspaceCollapsed: true, inspectorCollapsed: false, readingFontSize: 'large' },
      llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null },
      skills: { disabledBuiltins: [] },
      tools: { externalBins: [] },
    };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v3));
    const s = await loadSettings();
    expect(s.schemaVersion).toBe(4);
    expect(s.ui.locale).toBe('en');
    expect(s.onboarding).toEqual({ completedAt: null });
  });

  it('loadSettings: v4 原样回读（completedAt 保留）；非法 locale 归位 zh', async () => {
    ensureSettingsFile();
    const v4 = { ...defaultSettings(), ui: { ...defaultSettings().ui, locale: 'fr' }, onboarding: { completedAt: '2026-01-01T00:00:00.000Z' } };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v4));
    const s = await loadSettings();
    expect(s.onboarding.completedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(s.ui.locale).toBe('zh');
  });
});
