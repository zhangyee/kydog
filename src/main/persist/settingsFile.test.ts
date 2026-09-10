import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp, statSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from './paths';
import type { SettingsFile } from '../../shared/types';
import { ensureSettingsFile, loadSettings, readSettings, defaultSettings, parseAndMigrateSettings, checkInstitution, sanitizeInstitution, CURRENT_SCHEMA_VERSION, MIN_BROWSER_WIDTH, DEFAULT_BROWSER_WIDTH } from './settingsFile';

/**
 * 「备份失败就不覆盖原件」那道护栏没法用真文件系统触发：备份与覆盖写的是同一个目录，
 * 目录只读的话两次都失败，分不出「哪一次失败」。所以在模块边界上按目标路径挑一次让它抛。
 *
 * 默认 `failWhen` 为 null，一律穿透到真实实现 —— 本文件其余用例（备份内容逐字节相等、
 * 0600 权限）测的仍然是真的那一个写。**不用 vi.fn 包**：afterEach 里的 restoreAllMocks
 * 会把 vi.fn 的实现一并抹掉，那样穿透会静默变成「什么都不写」。
 */
const aw = vi.hoisted(() => ({ failWhen: null as ((target: string) => boolean) | null }));
vi.mock('./atomicWrite', async (orig) => {
  const actual = await orig<typeof import('./atomicWrite')>();
  return {
    ...actual,
    atomicWriteWith0600Async: async (target: string, data: string) => {
      if (aw.failWhen?.(target)) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${target}'`), { code: 'EACCES' });
      }
      return actual.atomicWriteWith0600Async(target, data);
    },
  };
});

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

  /**
   * `readSettings` 存在的全部理由：**把「拿到默认设置」的两种相反成因分开**。
   * 压成一份设置（`loadSettings`）的话，写路径分不出「文件真的不在」与
   * 「文件还在、只是这一次没读出来」，后者照写就是拿默认值盖掉真设置。
   */
  describe('readSettings 的四档判据', () => {
    it('读得出来 → ok，settings 是文件里那份', async () => {
      ensureSettingsFile();
      await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify(richSettings()));
      const r = await readSettings();
      expect(r.kind).toBe('ok');
      expect(r.settings.llm.auth).toMatchObject({ anthropic: { key: 'sk-REAL-KEY' } });
    });

    it('ENOENT → absent（文件真的不在，可以按默认设置往下写）', async () => {
      const r = await readSettings();
      expect(r.kind).toBe('absent');
      expect(r.settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('认不出来 → quarantined（原件已改名留档，盘上那份可以覆盖）', async () => {
      ensureSettingsFile();
      await fsp.writeFile(path.join(dir, 'kydog.json'), JSON.stringify({ ...richSettings(), schemaVersion: 999 }));
      const r = await readSettings();
      expect(r.kind).toBe('quarantined');
      // 留档真的发生了才算数 —— 只看 kind 的话，「没备份就说自己 quarantined」也能绿。
      expect(readdirSync(dir).some((f) => f.startsWith('kydog.json.') && f !== 'kydog.json')).toBe(true);
    });

    it('EACCES → unreadable，且 why 只有 errno、不带路径', async () => {
      ensureSettingsFile();
      vi.spyOn(fsp, 'readFile').mockRejectedValue(
        Object.assign(new Error("EACCES: permission denied, open '/Users/someone/.kydog/kydog.json'"), { code: 'EACCES' }),
      );
      const r = await readSettings();
      expect(r.kind).toBe('unreadable');
      // why 会经 app.bootstrap 过河进渲染层：errno 说得清「权限还是占用」，
      // 路径对用户没有新信息，还会把用户名带进界面。
      if (r.kind === 'unreadable') {
        expect(r.why).toBe('EACCES');
        expect(r.why).not.toContain('/');
        expect(r.why).not.toContain('someone');
      }
    });

    it('认不出来但**备份没成** → unreadable（原件还在原地，不许覆盖）', async () => {
      ensureSettingsFile();
      const original = JSON.stringify({ ...richSettings(), schemaVersion: 999 });
      await fsp.writeFile(path.join(dir, 'kydog.json'), original);
      // 只让备份那一次写失败 —— 覆盖原件那一次仍然是真的那个实现。
      aw.failWhen = (t) => t.includes('.unreadable-');
      const r = await readSettings();
      aw.failWhen = null;
      // 「舍不得覆盖」这道护栏挡住的文件，不能被下一次 withLock 写掉：
      // 判成 quarantined 就等于告诉写路径「留档已经在了，随便覆盖」——而留档根本没成。
      expect(r.kind).toBe('unreadable');
      expect(readFileSync(path.join(dir, 'kydog.json'), 'utf8'),
        '备份没成时原件必须原地不动').toBe(original);
    });

    it('errno 缺席（不是 ErrnoException）也算 unreadable，不会掉进 absent', async () => {
      ensureSettingsFile();
      vi.spyOn(fsp, 'readFile').mockRejectedValue(new Error('something odd'));
      const r = await readSettings();
      // 这一条挡的是「用 message 里有没有 ENOENT 去认」那种写法：
      // 认不出来的错误必须往**保守**那一侧倒，而不是当成「文件不在」去覆盖。
      expect(r.kind).toBe('unreadable');
    });
  });

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
    aw.failWhen = null;
  });
  afterEach(() => {
    aw.failWhen = null;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const backups = () => readdirSync(dir).filter((f) => f.startsWith('kydog.json.unreadable-'));
  const errorLines = () => errSpy.mock.calls.map((c) => String(c[0])).join('\n');

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

  // ── 两条护栏：任何一次写失败都不许让「读不懂」升级成「读不懂而且没了」 ──
  //
  // 磁盘满 / ~/.kydog 只读 / 外置盘被拔掉时备份写不成。少了下面这条 return，代码会
  // 继续往下把那份装着 API key、research presets、机构账号的 kydog.json 换成默认设置：
  // 备份不存在，原件也没了，不可逆。删掉 quarantineUnreadableSettings 里备份失败那个
  // return，这条用例必须红。
  it('备份写失败：原件一字不动、不留半份备份，日志说明白是备份失败', async () => {
    const file = path.join(dir, 'kydog.json');
    const raw = JSON.stringify(richSettings({ schemaVersion: 10 }), null, 2);
    await fsp.writeFile(file, raw);
    aw.failWhen = (t) => t.startsWith(`${file}.unreadable-`);

    // 调用方仍然拿到一份默认设置（本次会话能起来），但磁盘上什么都没被换掉
    const got = await loadSettings();
    expect(got.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    // (a) 原件逐字节未变 —— 读不懂但还在，用户能自己把 sk- 与机构账号捞回来
    expect(readFileSync(file, 'utf8')).toBe(raw);
    // (b) 连 atomicWrite 的临时文件都不该留下（前缀过滤把 .tmp.<uuid> 一并罩住）
    expect(backups()).toEqual([]);
    // (c) 日志分得出「没备份成」和「备份了但没换成默认」，否则事后无从判断原件还在不在
    expect(errorLines()).toContain('backup failed');
  });

  it('备份成功但写默认失败：备份与原件都留着，且不谎报「已从默认设置起步」', async () => {
    const file = path.join(dir, 'kydog.json');
    const raw = JSON.stringify(richSettings({ schemaVersion: 10 }), null, 2);
    await fsp.writeFile(file, raw);
    aw.failWhen = (t) => t === file;

    const got = await loadSettings();
    expect(got.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

    const names = backups();
    expect(names.length).toBe(1);
    expect(readFileSync(path.join(dir, names[0]), 'utf8')).toBe(raw);
    // 原件没被换掉 —— 后果只是下次启动会再备份一份，比「换了但没备份」轻得多
    expect(readFileSync(file, 'utf8')).toBe(raw);
    expect(errorLines()).toContain('could not write defaults');
    // 那句「已备份，从默认设置起步」这时是假的：默认设置压根没落盘
    expect(errorLines()).not.toContain('starting from defaults');
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

  // passwordEnc 分三档，中间那档以前不存在（非字符串一律被改写成空串）。
  // 代价很具体：safeStorage.encryptString 回的是 Buffer，忘了 .toString('base64')
  // 直接落盘 → 界面显示「未设置密码」，全程零错误。三个标识字段缺失会整条丢，
  // 唯独密码这一档静默降级 —— 现在对齐了。
  it('有 passwordEnc 这个键但不是字符串 → 整条丢回 null，不改写成空串', () => {
    for (const bad of [{ type: 'Buffer', data: [1, 2, 3] }, 42, null, ['x'], true]) {
      const got = withInst({ name: 'n', entityID: 'e', username: 'u', passwordEnc: bad }).institution;
      expect(got, JSON.stringify(bad)).toBeNull();
    }
  });

  // 反证：没有这一句，上面那条也能被一个「passwordEnc 一律判死」的实现骗过去。
  it('是字符串就原样收下，空串也算 —— 「还没设密码」是合法状态', () => {
    expect(withInst({ name: 'n', entityID: 'e', username: 'u', passwordEnc: '' }).institution?.passwordEnc).toBe('');
    expect(withInst({ name: 'n', entityID: 'e', username: 'u', passwordEnc: 'B64==' }).institution?.passwordEnc).toBe('B64==');
  });

  // 读路径只要「行不行」，写路径要把「为什么不行」原样说给用户 —— 判据只有一个，
  // 所以两边不可能漂。
  it('checkInstitution 说得出为什么不行，且与 sanitizeInstitution 的判决一致', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ entityID: 'e', username: 'u' }, /机构名/],
      [{ name: 'n', entityID: 'e', username: 'u', passwordEnc: Buffer.from('x') }, /passwordEnc/],
      [{ name: 'n', entityID: 'e', username: 'u', passwordEnc: null }, /null/],
      ['不是对象', /不是一个对象/],
    ];
    for (const [v, why] of cases) {
      const r = checkInstitution(v);
      expect(r.ok, JSON.stringify(v)).toBe(false);
      expect(r.ok === false && r.why, JSON.stringify(v)).toMatch(why);
      expect(sanitizeInstitution(v), JSON.stringify(v)).toBeNull();
    }
    const good = { name: 'n', entityID: 'e', username: 'u', passwordEnc: 'B64==' };
    const r = checkInstitution(good);
    expect(r.ok).toBe(true);
    expect(r.ok === true && r.record).toEqual(sanitizeInstitution(good));
  });
});
