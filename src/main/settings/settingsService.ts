import { loadSettings, saveSettings, defaultSettings } from '../persist/settingsFile';
import type { SettingsFile } from '../../shared/types';

class SettingsService {
  private cache: SettingsFile | null = null;
  async get(): Promise<SettingsFile> {
    if (!this.cache) this.cache = await loadSettings();
    return this.cache;
  }
  async update(patch: Partial<SettingsFile>): Promise<SettingsFile> {
    const current = await this.get();
    const next: SettingsFile = {
      ...current,
      ...patch,
      schemaVersion: 1,
      ui: { ...current.ui, ...(patch.ui ?? {}) },
      llm: { ...current.llm, ...(patch.llm ?? {}) },
    };
    await saveSettings(next);
    this.cache = next;
    return next;
  }
  async reset(): Promise<void> {
    this.cache = defaultSettings();
    await saveSettings(this.cache);
  }
}

export const settingsService = new SettingsService();
