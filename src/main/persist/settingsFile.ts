// src/main/persist/settingsFile.ts
import { promises as fsp, statSync, chmodSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { atomicWriteWith0600Async } from './atomicWrite';
import * as paths from './paths';
import type { SettingsFile } from '../../shared/types';
import { logger } from '../log';

export function defaultSettings(): SettingsFile {
  return {
    schemaVersion: 3,
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
  return parseAndMigrate(raw);
}

export async function saveSettings(value: SettingsFile): Promise<void> {
  await atomicWriteWith0600Async(paths.SETTINGS_FILE, JSON.stringify(value, null, 2));
}

/** v1/v2 → v3 迁移。
 *  - v1：保留 ui/skills/tools，重置 llm（与旧行为一致），补 readingFontSize 默认值。
 *  - v2：保留所有字段，仅补 readingFontSize 默认值。
 *  - v3：原样回写。
 *  - 形状不对：全部 default。 */
function parseAndMigrate(raw: string): SettingsFile {
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { return defaultSettings(); }
  if (!parsed || typeof parsed !== 'object') return defaultSettings();
  const d = defaultSettings();

  // v3：直接合并，d.ui 兜底缺字段
  if (parsed.schemaVersion === 3) {
    return {
      schemaVersion: 3,
      ui: { ...d.ui, ...(parsed.ui ?? {}) },
      llm: {
        auth: parsed.llm?.auth ?? {},
        providers: parsed.llm?.providers ?? {},
        customProviders: parsed.llm?.customProviders ?? [],
        defaultProvider: parsed.llm?.defaultProvider ?? null,
        defaultModel: parsed.llm?.defaultModel ?? null,
      },
      skills: { ...d.skills, ...(parsed.skills ?? {}) },
      tools: { ...d.tools, ...(parsed.tools ?? {}) },
    };
  }

  // v2 → v3：保留 llm，ui 合并 default 自动补 readingFontSize
  if (parsed.schemaVersion === 2) {
    logger.warn('persist.settingsFile', 'migrating schema v2 → v3');
    return {
      schemaVersion: 3,
      ui: { ...d.ui, ...(parsed.ui ?? {}) },
      llm: {
        auth: parsed.llm?.auth ?? {},
        providers: parsed.llm?.providers ?? {},
        customProviders: parsed.llm?.customProviders ?? [],
        defaultProvider: parsed.llm?.defaultProvider ?? null,
        defaultModel: parsed.llm?.defaultModel ?? null,
      },
      skills: { ...d.skills, ...(parsed.skills ?? {}) },
      tools: { ...d.tools, ...(parsed.tools ?? {}) },
    };
  }

  // v1 或更旧：reset llm、补 ui 默认（包括 readingFontSize）
  logger.warn('persist.settingsFile', 'schema v1 detected; resetting llm to v3 default');
  return {
    schemaVersion: 3,
    ui: { ...d.ui, ...(parsed.ui ?? {}) },
    llm: d.llm,
    skills: { ...d.skills, ...(parsed.skills ?? {}) },
    tools: { ...d.tools, ...(parsed.tools ?? {}) },
  };
}
