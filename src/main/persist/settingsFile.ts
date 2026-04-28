import { promises as fs } from 'node:fs';
import { atomicWrite } from './atomicWrite';
import * as paths from './paths';
import type { SettingsFile } from '../../shared/types';
import { logger } from '../log';

export function defaultSettings(): SettingsFile {
  return {
    schemaVersion: 1,
    ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false },
    llm: { provider: null },
  };
}

export async function loadSettings(): Promise<SettingsFile> {
  try {
    const raw = await fs.readFile(paths.SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as SettingsFile;
    if (parsed && parsed.schemaVersion === 1 && parsed.ui && parsed.llm) return parsed;
    logger.warn('persist.settingsFile', 'load failed; returning defaults', { reason: 'shape mismatch' });
    return defaultSettings();
  } catch (err) {
    logger.warn('persist.settingsFile', 'load failed; returning defaults', { err: String(err) });
    return defaultSettings();
  }
}

export async function saveSettings(value: SettingsFile): Promise<void> {
  await atomicWrite(paths.SETTINGS_FILE, JSON.stringify(value, null, 2));
}
