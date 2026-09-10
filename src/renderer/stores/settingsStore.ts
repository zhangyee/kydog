import { create } from 'zustand';
import type { SettingsFileForRenderer, OnboardingRecovery, SettingsHealth } from '../../shared/types';

type SettingsState = {
  // 渲染层永远只拿得到不含 passwordEnc 的那一份 —— 主进程收口处已经转换过
  // （settingsService.toRendererSettings）。这里写 SettingsFile 就等于给密文开了个位置。
  settings: SettingsFileForRenderer | null;
  appVersion: string;
  bootstrapped: boolean;
  systemLocale: 'zh' | 'en';
  onboardingRecovery: OnboardingRecovery;
  /** 设置文件这一次是怎么读出来的；`ok` 之外设置页要挂横幅。 */
  settingsHealth: SettingsHealth;
  setSettings: (s: SettingsFileForRenderer) => void;
  setAppVersion: (v: string) => void;
  setBootstrapped: (b: boolean) => void;
  setBootstrapMeta: (m: { systemLocale: 'zh' | 'en'; onboardingRecovery: OnboardingRecovery; settingsHealth: SettingsHealth }) => void;
  setOnboardingRecovery: (r: OnboardingRecovery) => void;
};

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  appVersion: '',
  bootstrapped: false,
  systemLocale: 'zh',
  onboardingRecovery: 'none',
  settingsHealth: { kind: 'ok' },
  setSettings: (s) => set({ settings: s }),
  setAppVersion: (v) => set({ appVersion: v }),
  setBootstrapped: (b) => set({ bootstrapped: b }),
  setBootstrapMeta: (m) => set({
    systemLocale: m.systemLocale, onboardingRecovery: m.onboardingRecovery, settingsHealth: m.settingsHealth,
  }),
  setOnboardingRecovery: (r) => set({ onboardingRecovery: r }),
}));
