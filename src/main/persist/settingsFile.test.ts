import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, statSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from './paths';
import type { SettingsFile } from '../../shared/types';
import { ensureSettingsFile, loadSettings, defaultSettings, parseAndMigrateSettings, CURRENT_SCHEMA_VERSION, MIN_BROWSER_WIDTH, DEFAULT_BROWSER_WIDTH } from './settingsFile';

/** 只给「这份原文应当被认出来」的用例用。认不出来当场炸，免得断言写在一个
 *  判别联合的错误分支上还全绿。 */
function migrated(raw: string): SettingsFile {
  const r = parseAndMigrateSettings(raw);
  if (r.kind !== 'ok') throw new Error(`应当被识别为可迁移，却判成 ${r.kind}/${r.reason}`);
  return r.settings;
}

/** 一份「有真东西可丢」的 v9 文件：API key、机构账号、research preset 各一份。
 *  A 组用例要证明的正是这些东西在版本认不出来时不会被静默抹掉。 */
function richSettings(over: Record<string, unknown> = {}): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(defaultSettings())) as Record<string, unknown>;
  (s.llm as Record<string, unknown>).auth = { anthropic: { type: 'api_key', key: 'sk-REAL-KEY' } };
  (s.llm as Record<string, unknown>).defaultProvider = 'anthropic';
  s.research = { presets: { NCBI_API_KEY: 'k1' }, custom: [] };
  s.institution = {
    name: '北京大学', entityID: 'https://idp.pku.edu.cn/idp/shibboleth',
    username: '2100012345', passwordEnc: 'BASE64==',
    confirmedLogin: { entityID: 'https://idp.pku.edu.cn/idp/shibboleth', origin: 'https://iaaa.pku.edu.cn' },
  };
  return { ...s, ...over };
}

describe('settingsFile v9', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-settings-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('defaultSettings: schemaVersion=9 + 空 llm + readingFontSize=medium', () => {
    const d = defaultSettings();
    expect(d.schemaVersion).toBe(9);
    expect(d.ui.readingFontSize).toBe('medium');
    expect(d.llm.auth).toEqual({});
    expect(d.llm.providers).toEqual({});
    expect(d.llm.customProviders).toEqual([]);
    expect(d.llm.defaultProvider).toBeNull();
    expect(d.llm.defaultModel).toBeNull();
  });

  it('ensureSettingsFile: 创建 ~/.kydog (0700) + kydog.json (0600) v9', () => {
    ensureSettingsFile();
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(dir, 'kydog.json')).mode & 0o777).toBe(0o600);
    }
    const content = readFileSync(path.join(dir, 'kydog.json'), 'utf8');
    expect(JSON.parse(content).schemaVersion).toBe(9);
  });

  it('ensureSettingsFile: 已存在文件不覆盖', async () => {
    ensureSettingsFile();
    await fsp.writeFile(path.join(dir, 'kydog.json'), '{"sentinel":1}');
    ensureSettingsFile();
    const content = readFileSync(path.join(dir, 'kydog.json'), 'utf8');
    expect(content).toBe('{"sentinel":1}');
  });

  it('loadSettings: v1 → v9 reset (保留 ui/skills/tools，重置 llm)', async () => {
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
    expect(next.schemaVersion).toBe(9);
    expect(next.ui.theme).toBe('midnight');
    expect(next.ui.readingFontSize).toBe('medium');
    expect(next.skills.disabledBuiltins).toEqual(['old']);
    expect(next.llm.auth).toEqual({});
    expect(next.llm.providers).toEqual({});
  });

  it('loadSettings: v2 → v9（保留所有字段，补 readingFontSize=medium）', async () => {
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
    expect(next.schemaVersion).toBe(9);
    expect(next.ui.theme).toBe('midnight');
    expect(next.ui.readingFontSize).toBe('medium');
    expect(next.llm.defaultProvider).toBe('anthropic');
    expect(next.skills.disabledBuiltins).toEqual(['old']);
  });

  it('loadSettings: v3 → v9（passthrough，保留 readingFontSize=large）', async () => {
    ensureSettingsFile();
    const v3 = defaultSettings();
    v3.ui.readingFontSize = 'large';
    v3.ui.theme = 'sepia';
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v3));
    const next = await loadSettings();
    expect(next.schemaVersion).toBe(9);
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

  it('defaultSettings: schemaVersion=9 + onboarding.completedAt=null', () => {
    const d = defaultSettings();
    expect(d.schemaVersion).toBe(9);
    expect(d.onboarding).toEqual({ completedAt: null });
    expect(d.ui.locale).toBe('zh');
  });

  it('loadSettings: v3 → v9 补 onboarding，保留其余字段', async () => {
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
    expect(s.schemaVersion).toBe(9);
    expect(s.onboarding).toEqual({ completedAt: null });
    expect(s.ui.theme).toBe('midnight');
    expect(s.llm.defaultProvider).toBe('anthropic');
  });

  it('loadSettings: v3 → v9 迁移时 ui.locale=\'en\' 保留', async () => {
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
    expect(s.schemaVersion).toBe(9);
    expect(s.ui.locale).toBe('en');
    expect(s.onboarding).toEqual({ completedAt: null });
  });

  it('loadSettings: v8 原样回读（completedAt 保留）；非法 locale 归位 zh', async () => {
    ensureSettingsFile();
    const v8 = { ...defaultSettings(), schemaVersion: 8, ui: { ...defaultSettings().ui, locale: 'fr' }, onboarding: { completedAt: '2026-01-01T00:00:00.000Z' } };
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(v8));
    const s = await loadSettings();
    expect(s.onboarding.completedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(s.ui.locale).toBe('zh');
  });

  it('defaultSettings: schemaVersion=9 + research 为空表', () => {
    const d = defaultSettings();
    expect(d.schemaVersion).toBe(9);
    expect(d.research).toEqual({ presets: {}, custom: [] });
  });

  it('loadSettings: v4 → v9 补出空 research，其余字段保留', async () => {
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
    expect(s.schemaVersion).toBe(9);
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
      schemaVersion: 8,
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

  it('loadSettings: v1 → v9 时 research 为空表', async () => {
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
    expect(s.schemaVersion).toBe(9);
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

describe('settings v5 → v9 迁移', () => {
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
    const got = migrated(v5);
    expect(got.schemaVersion).toBe(9);
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
    const got = migrated(v4);
    expect(got.schemaVersion).toBe(9);
    expect(got.updates).toEqual({ autoCheck: true, dismissedCandidateId: null });
    expect(got.research).toEqual({ presets: {}, custom: [] });
    expect(got.onboarding.completedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('v8 文件原样保留 updates 的真实值', () => {
    const v8 = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), schemaVersion: 8, updates: { autoCheck: false, dismissedCandidateId: 'https://example/x.zip' } });
    const got = migrated(v8);
    expect(got.updates).toEqual({ autoCheck: false, dismissedCandidateId: 'https://example/x.zip' });
  });

  it('updates 形状损坏时回落到默认值而不是把脏值透给上层', () => {
    const bad = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), schemaVersion: 8, updates: { autoCheck: 'yes', dismissedCandidateId: 42 } });
    const got = migrated(bad);
    expect(got.updates).toEqual({ autoCheck: true, dismissedCandidateId: null });
  });

  it('updates 逐字段兜形状：合法字段不被另一个字段的脏值牵连', () => {
    const bad = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), schemaVersion: 8, updates: { autoCheck: false, dismissedCandidateId: 42 } });
    expect(migrated(bad).updates).toEqual({ autoCheck: false, dismissedCandidateId: null });
  });

  it('schemaVersion 非数字（如手改成字符串 "5"）时不误入保留分支', () => {
    const bad = JSON.stringify(richSettings({ schemaVersion: '5' }));
    const got = parseAndMigrateSettings(bad);
    expect(got.kind).toBe('unreadable');
  });
});

/**
 * 认不出来的版本**不是** v1。
 *
 * 这条判据以前是 `v >= 2 && v <= 9`，其余一切落进「v1 或更旧」那个重置分支：
 * API key、research presets、机构账号全清、onboarding 归零并在下一次写盘时固化。
 * 装了带 v10 的版本再回退就会踩到 —— 这个项目发版史上已经有两桩需要回退的事故。
 */
describe('认不出来的 schemaVersion：留档，不重置', () => {
  const cases: Array<[string, unknown]> = [
    ['比自己新的 v10', 10],
    ['字符串 "9"', '9'],
    ['null', null],
    ['非整数 9.5', 9.5],
    ['布尔 true', true],
  ];

  for (const [label, v] of cases) {
    it(`${label} → unreadable，原版本号原样带出来`, () => {
      const got = parseAndMigrateSettings(JSON.stringify(richSettings({ schemaVersion: v })));
      expect(got.kind).toBe('unreadable');
      if (got.kind !== 'unreadable') return;
      expect(got.reason).toBe('unknown-version');
      expect(got.rawVersion).toBe(v);   // 原样，不转换成字符串也不归一化
    });
  }

  it('整个 schemaVersion 字段缺失 → unreadable（不当成 v1）', () => {
    const noVersion = richSettings();
    delete noVersion.schemaVersion;
    expect(parseAndMigrateSettings(JSON.stringify(noVersion)).kind).toBe('unreadable');
  });

  it('不是合法 JSON / 不是对象 → 同样是 unreadable，不静默换成默认设置', () => {
    expect(parseAndMigrateSettings('{ not json').kind).toBe('unreadable');
    expect(parseAndMigrateSettings('"a string"').kind).toBe('unreadable');
    expect(parseAndMigrateSettings('null').kind).toBe('unreadable');
  });

  it('真正的 v1 仍走升级路径（那是有意的迁移，不是「不认识」）', () => {
    const v1 = JSON.stringify({
      schemaVersion: 1,
      ui: { theme: 'midnight', locale: 'zh' },
      llm: { provider: { kind: 'openai-compat' } },
      skills: { disabledBuiltins: ['old'] },
    });
    const got = migrated(v1);
    expect(got.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(got.ui.theme).toBe('midnight');
    expect(got.skills.disabledBuiltins).toEqual(['old']);
  });

  it('v2..v9 一路原样加载', () => {
    for (let v = 2; v <= CURRENT_SCHEMA_VERSION; v += 1) {
      const got = migrated(JSON.stringify(richSettings({ schemaVersion: v })));
      expect(got.schemaVersion, `v${v}`).toBe(CURRENT_SCHEMA_VERSION);
      expect(got.llm.defaultProvider, `v${v}`).toBe('anthropic');
    }
  });
});

describe('loadSettings 遇到认不出来的文件：备份原件 + 起一份新的', () => {
  let dir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-unreadable-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  const backups = () => readdirSync(dir).filter((f) => f.startsWith('kydog.json.unreadable-'));

  it('v10 文件：原文一字不改地进备份，磁盘上换成默认设置，返回默认设置', async () => {
    const raw = JSON.stringify(richSettings({ schemaVersion: 10 }), null, 2);
    await fsp.writeFile(path.join(dir, 'kydog.json'), raw);

    const got = await loadSettings();
    expect(got.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(got.llm.auth).toEqual({});

    const names = backups();
    expect(names.length).toBe(1);
    // 一字不改：API key 与机构账号都还在备份里，用户能自己捞回来
    expect(readFileSync(path.join(dir, names[0]), 'utf8')).toBe(raw);
    // 备份里同样有明文密钥，权限不能比原件松
    if (process.platform !== 'win32') {
      expect(statSync(path.join(dir, names[0])).mode & 0o777).toBe(0o600);
    }
    // 备份文件名不能带冒号 —— Windows 上建不出来
    expect(names[0]).not.toContain(':');

    // 原位置换成全新默认设置：不这么做的话每次启动都会再备份一份
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'kydog.json'), 'utf8'));
    expect(onDisk.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(onDisk.llm.auth).toEqual({});
  });

  it('日志里记明原版本号、支持范围与备份路径', async () => {
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(richSettings({ schemaVersion: 10 })));
    await loadSettings();
    const lines = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('unreadable');
    expect(lines).toContain('"rawVersion":10');
    expect(lines).toContain(CURRENT_SCHEMA_VERSION.toString());
  });

  it('第二次启动不再产生第二份备份 —— 第一次已经把原件换掉了', async () => {
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(richSettings({ schemaVersion: 10 })));
    await loadSettings();
    await loadSettings();
    expect(backups().length).toBe(1);
  });

  it('v9 正常文件不会产生备份', async () => {
    await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(richSettings()));
    await loadSettings();
    expect(backups()).toEqual([]);
  });
});

describe('telemetry 迁移', () => {
  // 这条是本次迁移存在的理由：老用户从未被询问过，静默开启不是
  // 「有瑕疵的同意」而是没有同意。undecided 与「明确选了关」必须可区分。
  it('v6 迁到 v9 时 telemetry 为 undecided', () => {
    const v6 = JSON.stringify({ ...defaultSettings(), schemaVersion: 6, telemetry: undefined });
    const out = migrated(v6);
    expect(out.schemaVersion).toBe(9);
    expect(out.telemetry).toEqual({ state: 'undecided', decidedAt: null });
  });

  it('v1 迁到 v9 同样是 undecided', () => {
    const out = migrated(JSON.stringify({ schemaVersion: 1, ui: { theme: 'vellum' } }));
    expect(out.telemetry.state).toBe('undecided');
  });

  it('v8 原样保留用户的选择', () => {
    const v8 = JSON.stringify({
      ...defaultSettings(),
      schemaVersion: 8,
      telemetry: { state: 'enabled', decidedAt: '2026-08-05T10:00:00.000Z' },
    });
    expect(migrated(v8).telemetry)
      .toEqual({ state: 'enabled', decidedAt: '2026-08-05T10:00:00.000Z' });
  });

  // deleting 是最该被保住的状态：丢了它等于静默吞掉用户已经发出的删除请求 ——
  // 重启后 telemetryService.init() 正是靠它决定要不要重试删除
  it('v8 保留 deleting 状态，重启后才能重试删除', () => {
    const v8 = JSON.stringify({
      ...defaultSettings(),
      schemaVersion: 8,
      telemetry: { state: 'deleting', decidedAt: '2026-08-05T10:00:00.000Z' },
    });
    expect(migrated(v8).telemetry.state).toBe('deleting');
  });

  it('state 值非法时回落 undecided，decidedAt 一并回落', () => {
    const bad = JSON.stringify({ ...defaultSettings(), telemetry: { state: 'yes-please', decidedAt: 5 } });
    expect(migrated(bad).telemetry).toEqual({ state: 'undecided', decidedAt: null });
  });

  it('全新安装默认 undecided —— 由 onboarding 询问后写入', () => {
    expect(defaultSettings().telemetry).toEqual({ state: 'undecided', decidedAt: null });
  });
});

describe('ui.collapsedProjects（v7 → v9）', () => {
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
    const got = migrated(v7);
    expect(got.schemaVersion).toBe(9);
    expect(got.ui.collapsedProjects).toEqual([]);
    expect(got.ui.theme).toBe('sepia');
  });

  it('v8 原样回读用户收起的路径', () => {
    const v8 = JSON.stringify({
      ...JSON.parse(JSON.stringify(defaultSettings())),
      schemaVersion: 8,
      ui: { ...defaultSettings().ui, collapsedProjects: ['/p/a', '/p/b'] },
    });
    expect(migrated(v8).ui.collapsedProjects).toEqual(['/p/a', '/p/b']);
  });

  it('非数组时归空 —— 渲染层直接 new Set(...) 它，脏值会抛', () => {
    const bad = JSON.stringify({
      ...JSON.parse(JSON.stringify(defaultSettings())),
      ui: { ...defaultSettings().ui, collapsedProjects: 'nope' },
    });
    expect(migrated(bad).ui.collapsedProjects).toEqual([]);
  });

  it('数组里的非字符串元素被滤掉，合法路径保留', () => {
    const bad = JSON.stringify({
      ...JSON.parse(JSON.stringify(defaultSettings())),
      ui: { ...defaultSettings().ui, collapsedProjects: ['/p/a', null, 42, '/p/b'] },
    });
    expect(migrated(bad).ui.collapsedProjects).toEqual(['/p/a', '/p/b']);
  });

  it('v1 重置分支同样兜住这个字段', () => {
    const v1 = JSON.stringify({
      schemaVersion: 1,
      ui: { theme: 'midnight', locale: 'zh', collapsedProjects: ['/p/a', 7] },
      llm: { provider: { kind: 'openai-compat' } },
    });
    expect(migrated(v1).ui.collapsedProjects).toEqual(['/p/a']);
  });
});

describe('v8 → v9：浏览器侧栏', () => {
  it('老配置迁上来时侧栏是关的 —— 升级不该让界面自己多出一栏', () => {
    const v8 = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), schemaVersion: 8, ui: { theme: 'vellum', locale: 'zh' } });
    const got = migrated(v8);
    expect(got.schemaVersion).toBe(9);
    expect(got.ui.browserOpen).toBe(false);
    expect(got.ui.browserWidth).toBe(DEFAULT_BROWSER_WIDTH);
  });

  it('已存的 browserOpen/browserWidth 原样保留', () => {
    const raw = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), ui: { ...defaultSettings().ui, browserOpen: true, browserWidth: 720 } });
    const got = migrated(raw);
    expect(got.ui.browserOpen).toBe(true);
    expect(got.ui.browserWidth).toBe(720);
  });

  // 下限 320 的理由见 settingsFile.ts：页面按固定 1280 逻辑视口渲染，320px 时 scale
  // 已经是 0.25，再窄人眼读不了。手改成更小的值不能被接受 —— 那会让固定视口悄悄失效且不报错。
  //
  // 坏值里**没有 NaN**：JSON.stringify(NaN) 是 null，从磁盘这条路根本送不进来，
  // 写进去只是把 null 测了两遍。真能送进 NaN 的是 settings.update（渲染层拖拽算错一次），
  // 那条路的用例在 settingsService.test.ts。
  it('低于下限或形状不对的 browserWidth 拉回默认，不静默接受', () => {
    for (const bad of [100, 319, -5, 0, 'wide', null]) {
      const raw = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), ui: { ...defaultSettings().ui, browserWidth: bad } });
      expect(migrated(raw).ui.browserWidth).toBe(DEFAULT_BROWSER_WIDTH);
    }
    expect(migrated(JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), ui: { ...defaultSettings().ui, browserWidth: MIN_BROWSER_WIDTH } })).ui.browserWidth).toBe(MIN_BROWSER_WIDTH);
  });

  it('browserOpen 只认 true —— 手改成 "yes" / 1 不算开', () => {
    for (const bad of ['yes', 1, {}, 'true']) {
      const raw = JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), ui: { ...defaultSettings().ui, browserOpen: bad } });
      expect(migrated(raw).ui.browserOpen).toBe(false);
    }
  });
});

describe('v9：机构账号只兜形状不动值', () => {
  const PKU = 'https://idp.pku.edu.cn/idp/shibboleth';
  const withInst = (institution: unknown) =>
    migrated(JSON.stringify({ ...JSON.parse(JSON.stringify(defaultSettings())), institution }));

  it('没配过 → null；完整记录原样保留', () => {
    expect(withInst(undefined).institution).toBeNull();
    const full = { name: '北京大学', entityID: PKU, username: '2100012345', passwordEnc: 'BASE64==', confirmedLogin: { entityID: PKU, origin: 'https://iaaa.pku.edu.cn' } };
    expect(withInst(full).institution).toEqual(full);
  });

  // confirmedLogin 与 entityID 绑定：换了学校，上一次的确认必须当场作废。
  // 不作废的话，判据里 confirmedLogin 那一支会直接 return，entityID 根本不参与 ——
  // 主进程会把清华的账号密码填进北大的统一身份认证页。
  it('confirmedLogin.entityID 与记录的 entityID 不符 → 确认作废（回 null），其余字段保留', () => {
    const got = withInst({
      name: '清华大学', entityID: 'https://idp.tsinghua.edu.cn/idp/shibboleth',
      username: '2020010101', passwordEnc: 'X==',
      confirmedLogin: { entityID: PKU, origin: 'https://iaaa.pku.edu.cn' },
    }).institution;
    expect(got?.confirmedLogin).toBeNull();
    expect(got?.username).toBe('2020010101');
  });

  it('confirmedLogin 形状不对（缺 origin / 不是对象 / origin 不是字符串）→ 回 null', () => {
    for (const bad of [{ entityID: PKU }, { origin: 'https://a.b' }, 'iaaa.pku.edu.cn', 42, [], { entityID: PKU, origin: 5 }]) {
      const got = withInst({ name: 'n', entityID: PKU, username: 'u', passwordEnc: '', confirmedLogin: bad }).institution;
      expect(got?.confirmedLogin, JSON.stringify(bad)).toBeNull();
    }
  });

  // 旧形状只记 host、没有 scheme。**不许猜 https** —— 猜出来的 origin 是我们编的，
  // 不是用户确认过的那个。少一次确认对话框的代价，换不来伪造一条安全事实。
  it('旧的 confirmedLoginHost（只有 host、没有 scheme）不被顺手转成 origin', () => {
    const got = withInst({ name: 'n', entityID: PKU, username: 'u', passwordEnc: '', confirmedLoginHost: 'iaaa.pku.edu.cn' }).institution;
    expect(got?.confirmedLogin).toBeNull();
    expect(JSON.stringify(got)).not.toContain('iaaa.pku.edu.cn');
  });

  // 缺字段整条丢回 null，而不是补空串：一条 name/entityID 为空的记录在设置页上
  // 看起来像「配过了」，而 browser_login 的域判据要到运行时才失败 —— 那时用户
  // 已经不记得自己填过什么。宁可显示成「未配置」。
  it('name / entityID / username 缺任一 → 整条 null，不补空串', () => {
    expect(withInst({ entityID: 'e', username: 'u' }).institution).toBeNull();
    expect(withInst({ name: 'n', username: 'u' }).institution).toBeNull();
    expect(withInst({ name: 'n', entityID: 'e' }).institution).toBeNull();
    expect(withInst({ name: '', entityID: 'e', username: 'u' }).institution).toBeNull();
    expect(withInst('北京大学').institution).toBeNull();
    expect(withInst([]).institution).toBeNull();
  });

  it('配了机构与账号但还没设密码 → passwordEnc 为空串，不是 null', () => {
    const got = withInst({ name: 'n', entityID: 'e', username: 'u' }).institution;
    expect(got).toEqual({ name: 'n', entityID: 'e', username: 'u', passwordEnc: '', confirmedLogin: null });
  });
});
