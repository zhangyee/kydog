import { AppShell } from './AppShell';
import { OnboardingWizard } from '../onboarding/OnboardingWizard';
import { useSettingsStore } from '../stores/settingsStore';

export function Root() {
  const bootstrapped = useSettingsStore((s) => s.bootstrapped);
  const completedAt = useSettingsStore((s) => s.settings?.onboarding.completedAt ?? null);
  const recovery = useSettingsStore((s) => s.onboardingRecovery);

  if (!bootstrapped) {
    return (
      <div className="h-full w-full flex items-center justify-center"
        style={{ background: 'var(--color-paper)', color: 'var(--color-ink-faint)' }}>
        <span className="font-mono" style={{ fontSize: 11, letterSpacing: 1.5 }}>KYDOG</span>
      </div>
    );
  }
  if (completedAt !== null) return <AppShell />;
  return (
    <OnboardingWizard
      mode={recovery === 'pending' ? 'recovery' : 'fresh'}
      corruptNotice={recovery === 'corrupt-discarded'}
    />
  );
}
