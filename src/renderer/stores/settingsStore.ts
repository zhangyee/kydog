import { create } from 'zustand';
import type { SettingsFile, ProviderConfig } from '../../shared/types';

type SettingsState = {
  settings: SettingsFile | null;
  appVersion: string;
  setSettings: (s: SettingsFile) => void;
  setAppVersion: (v: string) => void;
};

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  appVersion: '',
  setSettings: (s) => set({ settings: s }),
  setAppVersion: (v) => set({ appVersion: v }),
}));

export type { ProviderConfig };
