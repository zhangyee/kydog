import { loadSettings as defaultLoad, saveSettings as defaultSave, defaultSettings } from '../persist/settingsFile';
import type { SettingsFile } from '../../shared/types';

export class SettingsService {
  private cache: SettingsFile | null = null;
  constructor(
    private readonly load: () => Promise<SettingsFile> = defaultLoad,
    private readonly save: (s: SettingsFile) => Promise<void> = defaultSave,
  ) {}
  async get(): Promise<SettingsFile> {
    if (!this.cache) this.cache = await this.load();
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
    await this.save(next);
    this.cache = next;
    return next;
  }
  async reset(): Promise<void> {
    this.cache = defaultSettings();
    await this.save(this.cache);
  }
}

export const settingsService = new SettingsService();
