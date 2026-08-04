// src/main/persist/settingsFile.ts
import { promises as fsp, statSync, chmodSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { atomicWriteWith0600Async } from './atomicWrite';
import * as paths from './paths';
import type { SettingsFile } from '../../shared/types';
import { logger } from '../log';

export function defaultSettings(): SettingsFile {
  return {
    schemaVersion: 5,
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

/** v1/v2/v3/v4 → v5 迁移。
 *  - v1：保留 ui/skills/tools，重置 llm（与旧行为一致），补 readingFontSize / onboarding / research 默认值。
 *  - v2/v3/v4：保留所有字段，补缺失的 onboarding / research 默认值。
 *  - v5：原样回写（completedAt 保留；locale 非法值归位 zh）。
 *  - 形状不对：全部 default。 */
export function parseAndMigrateSettings(raw: string): SettingsFile {
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { return defaultSettings(); }
  if (!parsed || typeof parsed !== 'object') return defaultSettings();
  const d = defaultSettings();
  const v = parsed.schemaVersion;

  if (v === 2 || v === 3 || v === 4 || v === 5) {
    if (v !== 5) logger.warn('persist.settingsFile', `migrating schema v${v} → v5`);
    return {
      schemaVersion: 5,
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
      research: {
        presets: parsed.research?.presets ?? {},
        custom: Array.isArray(parsed.research?.custom) ? parsed.research.custom : [],
      },
      onboarding: { completedAt: typeof parsed.onboarding?.completedAt === 'string' ? parsed.onboarding.completedAt : null },
    };
  }

  // v1 或更旧：reset llm、补 ui 默认（包括 readingFontSize）
  logger.warn('persist.settingsFile', 'schema v1 detected; resetting llm to v5 default');
  return {
    schemaVersion: 5,
    ui: { ...d.ui, ...(parsed.ui ?? {}), locale: sanitizeLocale(parsed.ui?.locale) },
    llm: d.llm,
    skills: { ...d.skills, ...(parsed.skills ?? {}) },
    tools: { ...d.tools, ...(parsed.tools ?? {}) },
    research: d.research,
    onboarding: { completedAt: null },
  };
}
