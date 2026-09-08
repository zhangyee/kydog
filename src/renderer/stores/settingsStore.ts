import { create } from 'zustand';
import type { SettingsFileForRenderer, OnboardingRecovery } from '../../shared/types';

type SettingsState = {
  // 渲染层永远只拿得到不含 passwordEnc 的那一份 —— 主进程收口处已经转换过
  // （settingsService.toRendererSettings）。这里写 SettingsFile 就等于给密文开了个位置。
  settings: SettingsFileForRenderer | null;
  appVersion: string;
  bootstrapped: boolean;
  systemLocale: 'zh' | 'en';
  onboardingRecovery: OnboardingRecovery;
  setSettings: (s: SettingsFileForRenderer) => void;
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
