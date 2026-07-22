import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { onboardingDict, type OnboardingLocale } from '../i18n/onboardingDict';
import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { useLlmStore } from '../stores/llmStore';
import { useIdentityStore } from '../stores/identityStore';
import { ProviderListSection } from '../settings/ProviderListSection';
import { AddProviderPage } from '../settings/AddProviderPage';
import { ProviderDetailPane } from '../settings/ProviderDetailPane';
import { THEME_NAMES, READING_FONT_SIZES, type ThemeName, type ReadingFontSize, type OnboardingErrorCode } from '../../shared/types';

type Step = 0 | 1 | 2 | 3 | 4;

const primaryBtn: CSSProperties = {
  padding: '6px 16px', borderRadius: 999, fontSize: 12, fontWeight: 500,
  color: 'var(--color-ink)', border: '0.5px solid var(--color-ink-hair)',
};
const primaryBtnClass = 'font-sans bg-[color:var(--color-paper-deep)] disabled:opacity-50 transition-colors hover:bg-[color:var(--color-hover-bg)]';
const textBtnStyle: CSSProperties = { background: 'transparent', color: 'var(--color-ink-soft)', fontSize: 11 };
const inputStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  borderBottom: '0.5px solid var(--color-ink-hair-soft)',
  padding: '7px 0',
  fontFamily: 'var(--font-mono)', fontSize: 11.5,
  color: 'var(--color-ink)',
  width: '100%',
  marginTop: 6,
};
const labelStyle: CSSProperties = { fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--color-ink)', fontWeight: 500 };

function pillStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 14px', borderRadius: 999, fontSize: 12,
    marginRight: 8, marginBottom: 8,
    border: active ? '0.5px solid var(--color-ink)' : '0.5px solid var(--color-ink-hair-soft)',
    background: active ? 'var(--color-paper-deep)' : 'transparent',
    color: 'var(--color-ink)',
  };
}

export function OnboardingWizard({ mode, corruptNotice }: { mode: 'fresh' | 'recovery'; corruptNotice: boolean }) {
  const systemLocale = useSettingsStore((s) => s.systemLocale);
  const [locale, setLocale] = useState<OnboardingLocale>(systemLocale);
  const [step, setStep] = useState<Step>(0);
  const [userName, setUserName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [theme, setTheme] = useState<ThemeName>('vellum');
  const [size, setSize] = useState<ReadingFontSize>('medium');
  const [error, setError] = useState<OnboardingErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  const t = onboardingDict[locale];

  const llmReady = useLlmStore((s) => s.defaultProvider !== null && s.defaultModel !== null);

  // 第 4/5 步预览：直接改 document 属性，不碰 uiStore(spec §8 第 4 步暂存)
  useEffect(() => {
    if (step >= 3) {
      document.documentElement.setAttribute('data-theme', theme);
      document.documentElement.setAttribute('data-reading-size', size);
    }
  }, [step, theme, size]);

  const applyOkAndEnter = async () => {
    useUiStore.getState().setTheme(theme);
    useUiStore.getState().setReadingFontSize(size);
    // bootstrap() 在 noProvider 时把 settingsTabOpen/activeCenterTab 写成了 settings 落地页(引导用户先配 provider)。
    // 向导走完后必须复位,否则新用户完成向导进主界面直接停在 Settings 页而非空态欢迎页。
    // closeSettings() 是 uiStore 现成 setter,一次性重置 settingsTabOpen/activeCenterTab,
    // 同时顺带清掉 settingsDetailProviderId/settingsAddProviderOpen——即第 3 步模型子步骤里
    // 可能打开过的 ProviderDetailPane/AddProviderPage 残留,避免主界面 Settings 首次打开时
    // 停在残留的子页面而不是 provider 列表。
    useUiStore.getState().closeSettings();
    const fresh = await window.kydog.invoke('settings.get');
    // recovery 模式下 userName/agentName 只是本组件本地的空 state,并非用户上次真实填写的称呼;
    // 用它们调 setIdentity 会用猜测值('You'/'KyDog')覆盖已有身份。recovery 的身份由
    // main 侧 onboarding.resume 完成后通过 identity.changed 事件推送、或下次 bootstrap() 读取,
    // 这里跳过即可,fresh 模式保持原逻辑不变。
    if (mode === 'fresh') {
      const id = { userName: userName.trim() || 'You', agentName: agentName.trim() || 'KyDog' };
      useIdentityStore.getState().setIdentity(id);
    }
    useSettingsStore.getState().setSettings(fresh); // completedAt 非空 → Root 切 AppShell
  };

  const submit = async () => {
    setBusy(true); setError(null);
    const result = mode === 'recovery'
      ? await window.kydog.invoke('onboarding.resume')
      : await window.kydog.invoke('onboarding.complete', {
          locale, theme, readingFontSize: size,
          userName: userName.trim() || 'You',
          agentName: agentName.trim() || 'KyDog',
        });
    setBusy(false);
    if (result.ok) { await applyOkAndEnter(); return; }
    switch (result.code) {
      case 'already-completed': await applyOkAndEnter(); return;
      case 'recovery-pending': useSettingsStore.getState().setOnboardingRecovery('pending'); return;
      case 'manifest-corrupt': useSettingsStore.getState().setOnboardingRecovery('corrupt-discarded'); return;
      default: setError(result.code);
    }
  };

  const steps = useMemo(() => [t.stepLanguage, t.stepNames, t.stepModel, t.stepLook, t.stepDone], [t]);

  // 离开第 3 步(模型/provider)前进到第 4 步时,收起可能残留打开的 ProviderDetailPane/AddProviderPage,
  // 把 provider 子导航复位到列表态,避免完成向导后主界面 Settings 首次打开时停在残留子页面。
  const goNext = () => {
    if (step === 2) {
      useUiStore.getState().closeSettingsDetail();
      useUiStore.getState().closeSettingsAddProvider();
    }
    setStep((s) => (s + 1) as Step);
  };

  if (mode === 'recovery') {
    return (
      <Frame title={t.recoveryTitle}>
        <p className="font-serif" style={{ fontSize: 13, color: 'var(--color-ink-soft)', lineHeight: 1.7 }}>{t.recoveryBody}</p>
        {error && <ErrorLine code={error} t={t} />}
        <footer style={{ marginTop: 24 }}>
          <button data-testid="onboarding-retry" disabled={busy} onClick={() => void submit()}
            className={primaryBtnClass} style={primaryBtn}>{t.retry}</button>
        </footer>
      </Frame>
    );
  }

  return (
    <Frame title={t.welcome} subtitle={steps[step]} corrupt={corruptNotice ? t.corruptNotice : null}>
      {step === 0 && (
        <div>
          <button data-testid="onboarding-locale-zh" aria-pressed={locale === 'zh'} onClick={() => setLocale('zh')}
            className="font-sans" style={pillStyle(locale === 'zh')}>中文</button>
          <button data-testid="onboarding-locale-en" aria-pressed={locale === 'en'} onClick={() => setLocale('en')}
            className="font-sans" style={pillStyle(locale === 'en')}>English</button>
        </div>
      )}
      {step === 1 && (
        <div>
          <label style={{ display: 'block', marginBottom: 20 }}>
            <span style={labelStyle}>{t.namesUserLabel}</span>
            <input data-testid="onboarding-username" value={userName} maxLength={64}
              placeholder={t.namesUserPlaceholder} onChange={(e) => setUserName(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ display: 'block' }}>
            <span style={labelStyle}>{t.namesAgentLabel}</span>
            <input data-testid="onboarding-agentname" value={agentName} maxLength={64}
              placeholder={t.namesAgentPlaceholder} onChange={(e) => setAgentName(e.target.value)} style={inputStyle} />
          </label>
        </div>
      )}
      {step === 2 && <ModelStep hint={t.modelHint} notReady={llmReady ? null : t.modelNotReady} />}
      {step === 3 && (
        <div>
          <div className="font-mono uppercase" style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.5, marginBottom: 10 }}>{t.lookTheme}</div>
          <div style={{ marginBottom: 24 }}>
            {THEME_NAMES.map((n) => (
              <button key={n} data-testid={`onboarding-theme-${n}`} aria-pressed={theme === n} onClick={() => setTheme(n)}
                className="font-sans" style={pillStyle(theme === n)}>{n}</button>
            ))}
          </div>
          <div className="font-mono uppercase" style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.5, marginBottom: 10 }}>{t.lookSize}</div>
          <div>
            {READING_FONT_SIZES.map((n) => (
              <button key={n} data-testid={`onboarding-size-${n}`} aria-pressed={size === n} onClick={() => setSize(n)}
                className="font-sans" style={pillStyle(size === n)}>
                {n === 'small' ? t.sizeSmall : n === 'medium' ? t.sizeMedium : t.sizeLarge}
              </button>
            ))}
          </div>
        </div>
      )}
      {step === 4 && (
        <div>
          <p className="font-serif" style={{ fontSize: 13, color: 'var(--color-ink-soft)', lineHeight: 1.7 }}>
            {t.doneSummary(userName.trim() || 'You', agentName.trim() || 'KyDog')}
          </p>
          {error && <ErrorLine code={error} t={t} />}
        </div>
      )}
      <footer style={{ marginTop: 28, display: 'flex', alignItems: 'center', gap: 12 }}>
        {step > 0 && <button data-testid="onboarding-back" onClick={() => setStep((s) => (s - 1) as Step)}
          className="font-sans" style={textBtnStyle}>{t.back}</button>}
        {step < 4 && step !== 2 && <button data-testid="onboarding-skip" onClick={() => setStep((s) => (s + 1) as Step)}
          className="font-sans" style={textBtnStyle}>{t.skip}</button>}
        <div style={{ flex: 1 }} />
        {step < 4 && (
          <button data-testid="onboarding-next" disabled={step === 2 && !llmReady}
            onClick={goNext}
            className={primaryBtnClass} style={primaryBtn}>{t.next}</button>
        )}
        {step === 4 && (
          <button data-testid="onboarding-finish" disabled={busy} onClick={() => void submit()}
            className={primaryBtnClass} style={primaryBtn}>{t.finish}</button>
        )}
      </footer>
    </Frame>
  );
}

/** 第 3 步：复用 SettingsPane 的 provider 三分支(列表/新增/详情)。 */
function ModelStep({ hint, notReady }: { hint: string; notReady: string | null }) {
  const detailProviderId = useUiStore((s) => s.settingsDetailProviderId);
  const addOpen = useUiStore((s) => s.settingsAddProviderOpen);
  const openAdd = useUiStore((s) => s.openSettingsAddProvider);
  useEffect(() => { void useLlmStore.getState().refresh(); }, []);
  return (
    <div>
      <p className="font-serif italic" style={{ fontSize: 12, color: 'var(--color-ink-soft)', marginBottom: 14 }}>{hint}</p>
      {detailProviderId ? <ProviderDetailPane /> : addOpen ? <AddProviderPage /> : <ProviderListSection onAdd={openAdd} />}
      {notReady && <p data-testid="onboarding-model-notready" className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-soft)', marginTop: 4 }}>{notReady}</p>}
    </div>
  );
}

function ErrorLine({ code, t }: { code: OnboardingErrorCode; t: (typeof onboardingDict)['zh'] }) {
  const msg = code === 'invalid-input' ? t.errInvalidInput : code === 'model-missing' ? t.errModelMissing : t.errSeedFailed;
  return <p data-testid="onboarding-error" role="alert" className="font-serif" style={{ fontSize: 12, color: 'var(--color-accent, #a04040)', marginTop: 12 }}>{msg}</p>;
}

function Frame({ title, subtitle, corrupt, children }: { title: string; subtitle?: string; corrupt?: string | null; children: ReactNode }) {
  return (
    <div data-testid="onboarding-root" className="ky-paper-grain h-full w-full overflow-y-auto"
      style={{ background: 'var(--color-paper)', color: 'var(--color-ink)' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '64px 24px' }}>
        <h1 className="font-serif" style={{ fontSize: 28 }}>{title}</h1>
        {subtitle && <div className="font-mono uppercase" style={{ fontSize: 10, letterSpacing: 1.5, color: 'var(--color-ink-faint)', marginTop: 8 }}>{subtitle}</div>}
        {corrupt && <p className="font-serif italic" style={{ marginTop: 12, fontSize: 12, color: 'var(--color-ink-soft)' }}>{corrupt}</p>}
        <div style={{ marginTop: 28 }}>{children}</div>
      </div>
    </div>
  );
}
