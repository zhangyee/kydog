// src/main/persist/settingsFile.ts
import { promises as fsp, statSync, chmodSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { atomicWriteWith0600Async } from './atomicWrite';
import * as paths from './paths';
import type { SettingsFile } from '../../shared/types';
import { logger } from '../log';

export function defaultSettings(): SettingsFile {
  return {
    schemaVersion: 2,
    ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false },
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

/** v1 → v2：保留 ui/skills/tools，llm 重置为空白；其他形状不对 → 全 default。 */
function parseAndMigrate(raw: string): SettingsFile {
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { return defaultSettings(); }
  if (!parsed || typeof parsed !== 'object') return defaultSettings();
  const d = defaultSettings();
  if (parsed.schemaVersion === 2) {
    return {
      schemaVersion: 2,
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
  // v1 或更旧 → reset llm，保留其它
  logger.warn('persist.settingsFile', 'schema v1 detected; resetting llm to v2 default');
  return {
    schemaVersion: 2,
    ui: { ...d.ui, ...(parsed.ui ?? {}) },
    llm: d.llm,
    skills: { ...d.skills, ...(parsed.skills ?? {}) },
    tools: { ...d.tools, ...(parsed.tools ?? {}) },
  };
}
