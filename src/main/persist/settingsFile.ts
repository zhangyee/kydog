// src/main/persist/settingsFile.ts
import { promises as fsp, statSync, chmodSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { atomicWriteWith0600Async } from './atomicWrite';
import * as paths from './paths';
import type { SettingsFile } from '../../shared/types';
import { logger } from '../log';

export function defaultSettings(): SettingsFile {
  return {
    schemaVersion: 6,
    ui: {
      theme: 'vellum',
      locale: 'zh',
      workspaceCollapsed: false,
      inspectorCollapsed: false,
      readingFontSize: 'medium',
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

/** v1..v5 → v6 迁移。
 *  - v1：保留 ui/skills/tools，重置 llm（与旧行为一致），补 readingFontSize / onboarding / research / updates 默认值。
 *  - v2/v3/v4/v5：保留所有字段，补缺失的 onboarding / research / updates 默认值。
 *  - v6：原样回写（completedAt 保留；locale 非法值归位 zh；updates 只兜形状）。
 *  - 形状不对：全部 default。 */
export function parseAndMigrateSettings(raw: string): SettingsFile {
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { return defaultSettings(); }
  if (!parsed || typeof parsed !== 'object') return defaultSettings();
  const d = defaultSettings();
  const v = parsed.schemaVersion;

  if (typeof v === 'number' && Number.isInteger(v) && v >= 2 && v <= 6) {
    if (v !== 6) logger.warn('persist.settingsFile', `migrating schema v${v} → v6`);
    return {
      schemaVersion: 6,
      ui: { ...d.ui, ...(parsed.ui ?? {}), locale: sanitizeLocale(parsed.ui?.locale) },
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
      onboarding: { completedAt: typeof parsed.onboarding?.completedAt === 'string' ? parsed.onboarding.completedAt : null },
    };
  }

  // v1 或更旧：reset llm、补 ui 默认（包括 readingFontSize）
  logger.warn('persist.settingsFile', 'schema v1 detected; resetting llm to v6 default');
  return {
    schemaVersion: 6,
    ui: { ...d.ui, ...(parsed.ui ?? {}), locale: sanitizeLocale(parsed.ui?.locale) },
    llm: d.llm,
    skills: { ...d.skills, ...(parsed.skills ?? {}) },
    tools: { ...d.tools, ...(parsed.tools ?? {}) },
    research: d.research,
    updates: d.updates,
    onboarding: { completedAt: null },
  };
}
