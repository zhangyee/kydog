import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, statSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from './paths';
import { ensureSettingsFile, loadSettings, defaultSettings, parseAndMigrateSettings } from './settingsFile';

describe('settingsFile v8', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-settings-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('defaultSettings: schemaVersion=8 + 空 llm + readingFontSize=medium', () => {
    const d = defaultSettings();
    expect(d.schemaVersion).toBe(8);
    expect(d.ui.readingFontSize).toBe('medium');
    expect(d.llm.auth).toEqual({});
    expect(d.llm.providers).toEqual({});
    expect(d.llm.customProviders).toEqual([]);
    expect(d.llm.defaultProvider).toBeNull();
    expect(d.llm.defaultModel).toBeNull();
  });

  it('ensureSettingsFile: 创建 ~/.kydog (0700) + kydog.json (0600) v8', () => {
    ensureSettingsFile();
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(dir, 'kydog.json')).mode & 0o777).toBe(0o600);
    }
    const content = readFileSync(path.join(dir, 'kydog.json'), 'utf8');
    expect(JSON.parse(content).schemaVersion).toBe(8);
  });

  it('ensureSettingsFile: 已存在文件不覆盖', async () => {
    ensureSettingsFile();
    await fsp.writeFile(path.join(dir, 'kydog.json'), '{"sentinel":1}');
    ensureSettingsFile();
    const content = readFileSync(path.join(dir, 'kydog.json'), 'utf8');
    expect(content).toBe('{"sentinel":1}');
  });

  it('loadSettings: v1 → v8 reset (保留 ui/skills/tools，重置 llm)', async () => {
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
    expect(next.schemaVersion).toBe(8);
    expect(next.ui.theme).toBe('midnight');
    expect(next.ui.readingFontSize).toBe('medium');
    expect(next.skills.disabledBuiltins).toEqual(['old']);
    expect(next.llm.auth).toEqual({});
    expect(next.llm.providers).toEqual({});
  });

  it('loadSettings: v2 → v8（保留所有字段，补 readingFontSize=medium）', async () => {
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
    expect(next.schemaVersion).toBe(8);
    expect(next.ui.theme).toBe('midnight');
    expect(next.ui.readingFontSize).toBe('medium');
    expect(next.llm.defaultProvider).toBe('anthropic');
    expect(next.skills.disabledBuiltins).toEqual(['old']);
  });

  it('loadSettings: v3 → v8（passthrough，保留 readingFontSize=large）', async () => {
    ensureSettingsFile();
    const v3 = defaultSettings();
    v3.ui.readingFontSize = 'large';
    v3.ui.theme = 'sepia';
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v3));
    const next = await loadSettings();
    expect(next.schemaVersion).toBe(8);
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

  it('defaultSettings: schemaVersion=8 + onboarding.completedAt=null', () => {
    const d = defaultSettings();
    expect(d.schemaVersion).toBe(8);
    expect(d.onboarding).toEqual({ completedAt: null });
    expect(d.ui.locale).toBe('zh');
  });

  it('loadSettings: v3 → v8 补 onboarding，保留其余字段', async () => {
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
    expect(s.schemaVersion).toBe(8);
    expect(s.onboarding).toEqual({ completedAt: null });
    expect(s.ui.theme).toBe('midnight');
    expect(s.llm.defaultProvider).toBe('anthropic');
  });

  it('loadSettings: v3 → v8 迁移时 ui.locale=\'en\' 保留', async () => {
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
    expect(s.schemaVersion).toBe(8);
    expect(s.ui.locale).toBe('en');
    expect(s.onboarding).toEqual({ completedAt: null });
  });

  it('loadSettings: v8 原样回读（completedAt 保留）；非法 locale 归位 zh', async () => {
    ensureSettingsFile();
    const v8 = { ...defaultSettings(), ui: { ...defaultSettings().ui, locale: 'fr' }, onboarding: { completedAt: '2026-01-01T00:00:00.000Z' } };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v8));
    const s = await loadSettings();
    expect(s.onboarding.completedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(s.ui.locale).toBe('zh');
  });

  it('defaultSettings: schemaVersion=8 + research 为空表', () => {
    const d = defaultSettings();
    expect(d.schemaVersion).toBe(8);
    expect(d.research).toEqual({ presets: {}, custom: [] });
  });

  it('loadSettings: v4 → v8 补出空 research，其余字段保留', async () => {
    ensureSettingsFile();
    const v4 = {
      schemaVersion: 4,
      ui: { theme: 'sepia', locale: 'en', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'large' },
      llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: 'anthropic', defaultModel: 'm1' },
      skills: { disabledBuiltins: ['x'] },
      tools: { externalBins: [] },
      onboarding: { completedAt: '2026-01-01T00:00:00.000Z' },
    };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v4));
    const s = await loadSettings();
    expect(s.schemaVersion).toBe(8);
    expect(s.research).toEqual({ presets: {}, custom: [] });
    expect(s.ui.theme).toBe('sepia');
    expect(s.ui.locale).toBe('en');
    expect(s.llm.defaultProvider).toBe('anthropic');
    expect(s.onboarding.completedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('loadSettings: v8 原样回读 research', async () => {
    ensureSettingsFile();
    const v8 = {
      ...defaultSettings(),
      research: {
        presets: { NCBI_API_KEY: 'k1' },
        custom: [{ name: 'MY_KEY', kind: 'key', value: 'v1' }],
      },
    };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v8));
    const s = await loadSettings();
    expect(s.research.presets).toEqual({ NCBI_API_KEY: 'k1' });
    expect(s.research.custom).toEqual([{ name: 'MY_KEY', kind: 'key', value: 'v1' }]);
  });

  it('loadSettings: research.custom 不是数组时兜底成 []', async () => {
    ensureSettingsFile();
    const bad = { ...defaultSettings(), research: { presets: { A: 'b' }, custom: 'nope' } };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(bad));
    const s = await loadSettings();
    expect(s.research.presets).toEqual({ A: 'b' });
    expect(s.research.custom).toEqual([]);
  });

  it('loadSettings: research.custom 混入 null 等畸形元素时被滤掉，合法条目保留', async () => {
    ensureSettingsFile();
    // JSON.stringify 会把数组空洞序列化成 null；手改 kydog.json 也可能直接写出这种形状。
    const bad = {
      ...defaultSettings(),
      research: { presets: {}, custom: [null, { name: 'MY_KEY', kind: 'key', value: 'v1' }] },
    };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(bad));
    const s = await loadSettings();
    expect(s.research.custom).toEqual([{ name: 'MY_KEY', kind: 'key', value: 'v1' }]);
  });

  it('loadSettings: v1 → v8 时 research 为空表', async () => {
    ensureSettingsFile();
    const v1 = {
      schemaVersion: 1,
      ui: { theme: 'midnight', locale: 'zh', workspaceCollapsed: true, inspectorCollapsed: false },
      llm: { provider: { kind: 'openai-compat' } },
      skills: { disabledBuiltins: ['old'] },
      tools: { externalBins: [] },
    };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v1));
    const s = await loadSettings();
    expect(s.schemaVersion).toBe(8);
    expect(s.research).toEqual({ presets: {}, custom: [] });
  });

  it('research 容器形状不对时兜底：presets 非对象归空表、custom 里的数组元素被滤掉', async () => {
    ensureSettingsFile();
    const bad = {
      ...defaultSettings(),
      research: { presets: ['a', 'b'], custom: [['x'], { name: 'OK_KEY', kind: 'key', value: 'v' }] },
    };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(bad));
    const s = await loadSettings();
    expect(s.research.presets).toEqual({});
    expect(s.research.custom).toEqual([{ name: 'OK_KEY', kind: 'key', value: 'v' }]);
  });

  it('research.presets 是字符串时归空表', async () => {
    ensureSettingsFile();
    const bad = { ...defaultSettings(), research: { presets: 'garbage', custom: [] } };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(bad));
    expect((await loadSettings()).research.presets).toEqual({});
  });
});

describe('settings v5 → v8 迁移', () => {
  it('v5 旧文件补齐 updates 节的默认值', () => {
    const v5 = JSON.stringify({
      schemaVersion: 5,
      ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'medium' },
      llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null },
      skills: { disabledBuiltins: [] },
      tools: { externalBins: [] },
      research: { presets: {}, custom: [] },
      onboarding: { completedAt: '2026-01-01T00:00:00.000Z' },
    });
    const got = parseAndMigrateSettings(v5);
    expect(got.schemaVersion).toBe(8);
    expect(got.updates).toEqual({ autoCheck: true, dismissedCandidateId: null });
    expect(got.onboarding.completedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('v4 旧文件补齐 updates 与 research 的默认值（e2e helpers.ts 依赖此路径）', () => {
    const v4 = JSON.stringify({
      schemaVersion: 4,
      ui: { theme: 'sepia', locale: 'en', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'large' },
      llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: 'anthropic', defaultModel: 'm1' },
      skills: { disabledBuiltins: ['x'] },
      tools: { externalBins: [] },
      onboarding: { completedAt: '2026-01-01T00:00:00.000Z' },
    });
    const got = parseAndMigrateSettings(v4);
    expect(got.schemaVersion).toBe(8);
    expect(got.updates).toEqual({ autoCheck: true, dismissedCandidateId: null });
    expect(got.research).toEqual({ presets: {}, custom: [] });
    expect(got.onboarding.completedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('v8 文件原样保留 updates 的真实值', () => {
    const v8 = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), updates: { autoCheck: false, dismissedCandidateId: 'https://example/x.zip' } });
    const got = parseAndMigrateSettings(v8);
    expect(got.updates).toEqual({ autoCheck: false, dismissedCandidateId: 'https://example/x.zip' });
  });

  it('updates 形状损坏时回落到默认值而不是把脏值透给上层', () => {
    const bad = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), schemaVersion: 8, updates: { autoCheck: 'yes', dismissedCandidateId: 42 } });
    const got = parseAndMigrateSettings(bad);
    expect(got.updates).toEqual({ autoCheck: true, dismissedCandidateId: null });
  });

  it('updates 逐字段兜形状：合法字段不被另一个字段的脏值牵连', () => {
    const bad = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), schemaVersion: 8, updates: { autoCheck: false, dismissedCandidateId: 42 } });
    expect(parseAndMigrateSettings(bad).updates).toEqual({ autoCheck: false, dismissedCandidateId: null });
  });

  it('schemaVersion 非数字（如手改成字符串 "5"）时不误入保留分支，llm 被当 v1-或更旧重置', () => {
    const withLlm = JSON.parse(JSON.stringify(defaultSettings()));
    withLlm.llm.defaultProvider = 'anthropic';
    withLlm.llm.defaultModel = 'claude-sonnet-4-5';
    const bad = JSON.stringify({ ...withLlm, schemaVersion: '5' });
    const got = parseAndMigrateSettings(bad);
    expect(got.schemaVersion).toBe(8);
    // 落入保留分支的话 defaultProvider 会是 'anthropic'；落入 v1 重置分支才会是 null。
    expect(got.llm.defaultProvider).toBeNull();
    expect(got.llm.defaultModel).toBeNull();
    expect(got.updates).toEqual({ autoCheck: true, dismissedCandidateId: null });
  });

  it('超出已知范围的 schemaVersion 走重置分支 —— 下次 bump 记得抬高上界', () => {
    const v9 = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), schemaVersion: 9 });
    const got = parseAndMigrateSettings(v9);
    expect(got.schemaVersion).toBe(8);
    expect(got.llm.defaultProvider).toBeNull();
  });
});

describe('telemetry 迁移', () => {
  // 这条是本次迁移存在的理由：老用户从未被询问过，静默开启不是
  // 「有瑕疵的同意」而是没有同意。undecided 与「明确选了关」必须可区分。
  it('v6 迁到 v8 时 telemetry 为 undecided', () => {
    const v6 = JSON.stringify({ ...defaultSettings(), schemaVersion: 6, telemetry: undefined });
    const out = parseAndMigrateSettings(v6);
    expect(out.schemaVersion).toBe(8);
    expect(out.telemetry).toEqual({ state: 'undecided', decidedAt: null });
  });

  it('v1 迁到 v8 同样是 undecided', () => {
    const out = parseAndMigrateSettings(JSON.stringify({ schemaVersion: 1, ui: { theme: 'vellum' } }));
    expect(out.telemetry.state).toBe('undecided');
  });

  it('v8 原样保留用户的选择', () => {
    const v8 = JSON.stringify({
      ...defaultSettings(),
      telemetry: { state: 'enabled', decidedAt: '2026-08-05T10:00:00.000Z' },
    });
    expect(parseAndMigrateSettings(v8).telemetry)
      .toEqual({ state: 'enabled', decidedAt: '2026-08-05T10:00:00.000Z' });
  });

  // deleting 是最该被保住的状态：丢了它等于静默吞掉用户已经发出的删除请求 ——
  // 重启后 telemetryService.init() 正是靠它决定要不要重试删除
  it('v8 保留 deleting 状态，重启后才能重试删除', () => {
    const v8 = JSON.stringify({
      ...defaultSettings(),
      telemetry: { state: 'deleting', decidedAt: '2026-08-05T10:00:00.000Z' },
    });
    expect(parseAndMigrateSettings(v8).telemetry.state).toBe('deleting');
  });

  it('state 值非法时回落 undecided，decidedAt 一并回落', () => {
    const bad = JSON.stringify({ ...defaultSettings(), telemetry: { state: 'yes-please', decidedAt: 5 } });
    expect(parseAndMigrateSettings(bad).telemetry).toEqual({ state: 'undecided', decidedAt: null });
  });

  it('全新安装默认 undecided —— 由 onboarding 询问后写入', () => {
    expect(defaultSettings().telemetry).toEqual({ state: 'undecided', decidedAt: null });
  });
});

describe('ui.collapsedProjects（v7 → v8）', () => {
  it('全新安装是空数组 —— 默认全展开', () => {
    expect(defaultSettings().ui.collapsedProjects).toEqual([]);
  });

  it('v7 老文件没有这个字段 → 补空数组（老用户的 project 全是展开的）', () => {
    const v7 = JSON.stringify({
      schemaVersion: 7,
      ui: { theme: 'sepia', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'large' },
      llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null },
      skills: { disabledBuiltins: [] },
      tools: { externalBins: [] },
      research: { presets: {}, custom: [] },
      onboarding: { completedAt: null },
    });
    const got = parseAndMigrateSettings(v7);
    expect(got.schemaVersion).toBe(8);
    expect(got.ui.collapsedProjects).toEqual([]);
    expect(got.ui.theme).toBe('sepia');
  });

  it('v8 原样回读用户收起的路径', () => {
    const v8 = JSON.stringify({
      ...JSON.parse(JSON.stringify(defaultSettings())),
      ui: { ...defaultSettings().ui, collapsedProjects: ['/p/a', '/p/b'] },
    });
    expect(parseAndMigrateSettings(v8).ui.collapsedProjects).toEqual(['/p/a', '/p/b']);
  });

  it('非数组时归空 —— 渲染层直接 new Set(...) 它，脏值会抛', () => {
    const bad = JSON.stringify({
      ...JSON.parse(JSON.stringify(defaultSettings())),
      ui: { ...defaultSettings().ui, collapsedProjects: 'nope' },
    });
    expect(parseAndMigrateSettings(bad).ui.collapsedProjects).toEqual([]);
  });

  it('数组里的非字符串元素被滤掉，合法路径保留', () => {
    const bad = JSON.stringify({
      ...JSON.parse(JSON.stringify(defaultSettings())),
      ui: { ...defaultSettings().ui, collapsedProjects: ['/p/a', null, 42, '/p/b'] },
    });
    expect(parseAndMigrateSettings(bad).ui.collapsedProjects).toEqual(['/p/a', '/p/b']);
  });

  it('v1 重置分支同样兜住这个字段', () => {
    const v1 = JSON.stringify({
      schemaVersion: 1,
      ui: { theme: 'midnight', locale: 'zh', collapsedProjects: ['/p/a', 7] },
      llm: { provider: { kind: 'openai-compat' } },
    });
    expect(parseAndMigrateSettings(v1).ui.collapsedProjects).toEqual(['/p/a']);
  });
});
