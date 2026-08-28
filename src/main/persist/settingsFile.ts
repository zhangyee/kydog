// src/main/persist/settingsFile.ts
import { promises as fsp, statSync, chmodSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { atomicWriteWith0600Async } from './atomicWrite';
import * as paths from './paths';
import type { SettingsFile, TelemetryState } from '../../shared/types';
import { logger } from '../log';

export function defaultSettings(): SettingsFile {
  return {
    schemaVersion: 8,
    ui: {
      theme: 'vellum',
      locale: 'zh',
      workspaceCollapsed: false,
      inspectorCollapsed: false,
      readingFontSize: 'medium',
      collapsedProjects: [],
    },
    llm: {
      auth: {},
      providers: {},
      customProviders: [],
      defaultProvider: null,
      defaultModel: null,
    },
    skills: { disabledBuiltins: [] },
    tools: { externalBins: [] },
    research: { presets: {}, custom: [] },
    updates: { autoCheck: true, dismissedCandidateId: null },
    telemetry: { state: 'undecided', decidedAt: null },
    onboarding: { completedAt: null },
  };
}

const POSIX = process.platform !== 'win32';

/** main 启动时调一次。确保 ~/.kydog/ 目录与 kydog.json 都存在且 0600。 */
export function ensureSettingsFile(): void {
  mkdirSync(paths.ROOT, { recursive: true, mode: POSIX ? 0o700 : undefined });
  if (POSIX) {
    try { chmodSync(paths.ROOT, 0o700); } catch { /* 忽略 */ }
  }
  if (!existsSync(paths.SETTINGS_FILE)) {
    const data = JSON.stringify(defaultSettings(), null, 2);
    writeFileSync(paths.SETTINGS_FILE, data, POSIX ? { encoding: 'utf8', mode: 0o600 } : 'utf8');
  }
}

/** 启动加载；不再需要 ENOENT fallback（init 已保证存在）。 */
export async function loadSettings(): Promise<SettingsFile> {
  let raw: string;
  try {
    raw = await fsp.readFile(paths.SETTINGS_FILE, 'utf8');
  } catch (err) {
    logger.warn('persist.settingsFile', 'load failed; returning defaults', { err: String(err) });
    return defaultSettings();
  }
  if (POSIX) {
    try {
      const mode = statSync(paths.SETTINGS_FILE).mode & 0o777;
      if (mode & 0o077) {
        logger.warn('persist.settingsFile', 'file mode loosened; resetting to 0600', { mode: mode.toString(8) });
        await fsp.chmod(paths.SETTINGS_FILE, 0o600);
      }
    } catch { /* 忽略 */ }
  }
  return parseAndMigrateSettings(raw);
}

export async function saveSettings(value: SettingsFile): Promise<void> {
  await atomicWriteWith0600Async(paths.SETTINGS_FILE, JSON.stringify(value, null, 2));
}

function sanitizeLocale(v: unknown): 'zh' | 'en' { return v === 'en' ? 'en' : 'zh'; }

/** ui 其余字段是标量、坏值最多显示得怪；这条是数组，坏值会让渲染层 `new Set(...)`
 *  直接抛。所以只有它单独兜形状：非数组回空，非字符串元素丢掉。 */
function sanitizeCollapsedProjects(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** 数组也是 object，单靠 typeof 分不出来 —— research 的两个容器都要排除数组。 */
function isPlainObject(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** updates 逐字段兜形状 —— 某个字段类型不对就只把该字段回默认，不牵连另一个。 */
function sanitizeUpdates(v: unknown): SettingsFile['updates'] {
  const d = { autoCheck: true, dismissedCandidateId: null as string | null };
  if (!isPlainObject(v)) return d;
  const o = v as Record<string, unknown>;
  return {
    autoCheck: typeof o.autoCheck === 'boolean' ? o.autoCheck : d.autoCheck,
    dismissedCandidateId: typeof o.dismissedCandidateId === 'string' ? o.dismissedCandidateId : null,
  };
}

const TELEMETRY_STATES: readonly TelemetryState[] = ['undecided', 'enabled', 'deleting', 'disabled'];

function sanitizeTelemetry(v: unknown): SettingsFile['telemetry'] {
  const d = { state: 'undecided' as TelemetryState, decidedAt: null as string | null };
  if (!isPlainObject(v)) return d;
  const o = v as Record<string, unknown>;
  // state 非法说明整份记录不可信，decidedAt 一并回落
  if (!TELEMETRY_STATES.includes(o.state as TelemetryState)) return d;
  return {
    state: o.state as TelemetryState,
    decidedAt: typeof o.decidedAt === 'string' ? o.decidedAt : null,
  };
}

/** v1..v7 → v8 迁移。
 *  - v1：保留 ui/skills/tools，重置 llm（与旧行为一致），补 readingFontSize / onboarding / research / updates 默认值。
 *  - v2..v7：保留所有字段，补缺失的 onboarding / research / updates 默认值。
 *  - v8：原样回写（completedAt 保留；locale 非法值归位 zh；updates 只兜形状）。
 *  - v6→v7：新增 telemetry，一律置 undecided（老用户从未被询问）。
 *  - v7→v8：新增 ui.collapsedProjects，一律置空（老用户的 project 全是展开的）。
 *  - 形状不对：全部 default。 */
export function parseAndMigrateSettings(raw: string): SettingsFile {
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { return defaultSettings(); }
  if (!parsed || typeof parsed !== 'object') return defaultSettings();
  const d = defaultSettings();
  const v = parsed.schemaVersion;

  if (typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= 8) {
    if (v !== 8) logger.warn('persist.settingsFile', `migrating schema v${v} → v8`);
    return {
      schemaVersion: 8,
      ui: {
        ...d.ui,
        ...(parsed.ui ?? {}),
        locale: sanitizeLocale(parsed.ui?.locale),
        collapsedProjects: sanitizeCollapsedProjects(parsed.ui?.collapsedProjects),
      },
      llm: {
        auth: parsed.llm?.auth ?? {},
        providers: parsed.llm?.providers ?? {},
        customProviders: parsed.llm?.customProviders ?? [],
        defaultProvider: parsed.llm?.defaultProvider ?? null,
        defaultModel: parsed.llm?.defaultModel ?? null,
      },
      skills: { ...d.skills, ...(parsed.skills ?? {}) },
      tools: { ...d.tools, ...(parsed.tools ?? {}) },
      // 只兜形状不动值：get() 刻意返回落盘原值（让手改过 kydog.json 的用户
      // 能看见真实状态），所以这里不 trim、不校验内容，但必须保证容器与元素
      // 的形状与类型标注一致 —— 否则 research.get 会把 SettingsFile 上那句
      // Record<string,string> / ResearchCustomVar[] 的承诺撒谎给渲染层。
      research: {
        presets: isPlainObject(parsed.research?.presets) ? parsed.research.presets : {},
        custom: Array.isArray(parsed.research?.custom)
          ? parsed.research.custom.filter(isPlainObject)
          : [],
      },
      updates: sanitizeUpdates(parsed.updates),
      telemetry: sanitizeTelemetry(parsed.telemetry),
      onboarding: { completedAt: typeof parsed.onboarding?.completedAt === 'string' ? parsed.onboarding.completedAt : null },
    };
  }

  // v1 或更旧：reset llm、补 ui 默认（包括 readingFontSize）
  logger.warn('persist.settingsFile', 'schema v1 detected; resetting llm to v8 default');
  return {
    schemaVersion: 8,
    ui: {
      ...d.ui,
      ...(parsed.ui ?? {}),
      locale: sanitizeLocale(parsed.ui?.locale),
      collapsedProjects: sanitizeCollapsedProjects(parsed.ui?.collapsedProjects),
    },
    llm: d.llm,
    skills: { ...d.skills, ...(parsed.skills ?? {}) },
    tools: { ...d.tools, ...(parsed.tools ?? {}) },
    research: d.research,
    updates: d.updates,
    telemetry: sanitizeTelemetry(parsed.telemetry),
    onboarding: { completedAt: null },
  };
}
