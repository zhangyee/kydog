import { create } from 'zustand';
import type { SettingsFile, OnboardingRecovery } from '../../shared/types';

type SettingsState = {
  settings: SettingsFile | null;
  appVersion: string;
  bootstrapped: boolean;
  systemLocale: 'zh' | 'en';
  onboardingRecovery: OnboardingRecovery;
  setSettings: (s: SettingsFile) => void;
  setAppVersion: (v: string) => void;
  setBootstrapped: (b: boolean) => void;
  setBootstrapMeta: (m: { systemLocale: 'zh' | 'en'; onboardingRecovery: OnboardingRecovery }) => void;
  setOnboardingRecovery: (r: OnboardingRecovery) => void;
};

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  appVersion: '',
  bootstrapped: false,
  systemLocale: 'zh',
  onboardingRecovery: 'none',
  setSettings: (s) => set({ settings: s }),
  setAppVersion: (v) => set({ appVersion: v }),
  setBootstrapped: (b) => set({ bootstrapped: b }),
  setBootstrapMeta: (m) => set({ systemLocale: m.systemLocale, onboardingRecovery: m.onboardingRecovery }),
  setOnboardingRecovery: (r) => set({ onboardingRecovery: r }),
}));
