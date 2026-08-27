import {
  useEffect, useMemo, useState,
  type CSSProperties, type InputHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react';
import { onboardingDict, type OnboardingLocale } from '../i18n/onboardingDict';
import { useSettingsStore } from '../stores/settingsStore';
import { useUiStore } from '../stores/uiStore';
import { useLlmStore } from '../stores/llmStore';
import { useIdentityStore } from '../stores/identityStore';
import { useSkillsStore } from '../stores/skillsStore';
import { ProviderListSection } from '../settings/ProviderListSection';
import { AddProviderPage } from '../settings/AddProviderPage';
import { ProviderDetailPane } from '../settings/ProviderDetailPane';
import { KyMascot } from '../shared';
import { THEME_NAMES, READING_FONT_SIZES, type ThemeName, type ReadingFontSize, type OnboardingErrorCode } from '../../shared/types';

type Step = 0 | 1 | 2 | 3 | 4;
type Dict = (typeof onboardingDict)['zh'];

// 双列布局仅第 4/5 步过渡用得到：切步时 remount + 150ms 淡入；聚焦态用 JS 状态而非 CSS
// 伪类驱动（内联 style 的优先级高于样式表，:focus 规则压不过内联 borderBottom，故不走 <style> 方案）。
const WIZARD_STYLE = `
@keyframes onboarding-step-fade { from { opacity: 0; } to { opacity: 1; } }
.onboarding-step-fade { animation: onboarding-step-fade 150ms ease-out; }
`;

const primaryBtn: CSSProperties = {
  padding: '6px 16px', borderRadius: 999, fontSize: 12, fontWeight: 500,
  color: 'var(--color-ink)', border: '0.5px solid var(--color-ink-hair)',
};
const primaryBtnClass = 'font-sans bg-[color:var(--color-paper-deep)] disabled:opacity-50 transition-colors hover:bg-[color:var(--color-hover-bg)]';
const textBtnStyle: CSSProperties = { background: 'transparent', color: 'var(--color-ink-soft)', fontSize: 11 };
const inputStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  outline: 'none',
  padding: '7px 0',
  // 正文默认字体，无额外字距——曾套 mono 字体，英文在等宽字体下被拉成全角观感（用户反馈）。
  fontFamily: 'var(--font-sans)', fontSize: 11.5,
  color: 'var(--color-ink)',
  width: '100%',
  marginTop: 6,
};
const labelStyle: CSSProperties = { fontFamily: 'var(--font-sans)', fontSize: 11.5, color: 'var(--color-ink-soft)', fontWeight: 500 };
const hintStyle: CSSProperties = { fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 12, color: 'var(--color-ink-soft)', marginTop: 14, lineHeight: 1.6 };

function pillStyle(active: boolean): CSSProperties {
  return {
    padding: '6px 14px', borderRadius: 999, fontSize: 12,
    marginRight: 8, marginBottom: 8,
    border: active ? '0.5px solid var(--color-ink)' : '0.5px solid var(--color-ink-hair-soft)',
    background: active ? 'var(--color-paper-deep)' : 'transparent',
    color: 'var(--color-ink)',
  };
}

/** 底边框式输入框：聚焦变 ink——inline style 驱动（不用 CSS :focus，避免被内联样式盖掉）。 */
function OnboardingInput({ testId, style, onFocus, onBlur, ...rest }: InputHTMLAttributes<HTMLInputElement> & { testId?: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <input
      data-testid={testId}
      className="font-sans"
      style={{
        ...inputStyle,
        borderBottom: `0.5px solid ${focused ? 'var(--color-ink)' : 'var(--color-ink-hair-soft)'}`,
        ...style,
      }}
      onFocus={(e) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); onBlur?.(e); }}
      {...rest}
    />
  );
}

// 完成页「这些文件属于你」清单——路径不需要翻译，只有说明文案走 dict。
const FILES_GUIDE = [
  { path: '~/.kydog/kydog.json', descKey: 'filesGuideSettingsDesc' as const },
  { path: '~/.kydog/SOUL.md', descKey: 'filesGuideSoulDesc' as const },
  { path: '~/.kydog/USER.md', descKey: 'filesGuideUserDesc' as const },
  { path: '~/.kydog/AGENTS.md', descKey: 'filesGuideAgentsDesc' as const },
];

function stepTitle(step: Step, t: Dict): string {
  switch (step) {
    case 0: return t.stepTitleLanguage;
    case 1: return t.stepTitleNames;
    case 2: return t.stepTitleModel;
    case 3: return t.stepTitleLook;
    case 4: return t.stepTitleDone;
  }
}

function stepHint(step: Step, t: Dict): string | null {
  switch (step) {
    case 1: return t.namesHint;
    case 2: return t.modelHint;
    case 3: return t.lookHint;
    default: return null;
  }
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
  // 默认打勾是知情后的产品决定，不是漏了：GDPR Recital 32 与欧盟法院 Planet49 案（C-673/17）
  // 认定预勾选不构成有效同意，也就是说对 EU/UK 用户而言此处的「同意」在协议上不成立。
  // 维护者两次确认仍要这个形态。要翻转就是把这里的 true 改成 false，别处不用动。
  const [telemetryEnabled, setTelemetryEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const t = onboardingDict[locale];

  const llmReady = useLlmStore((s) => s.defaultProvider !== null && s.defaultModel !== null);

  // 主题/字号预览：向导一 mount 就生效（bug 修复——原先要 step>=3 才设置 document 属性，
  // 导致真·首启时第 0-2 步全程跑在未定义的 CSS 变量下，即 vellum.css 等按 [data-theme="x"]
  // 选择器生效，属性没设就等于什么颜色/字体变量都没有）。回退步骤不撤销已选值——这里没有
  // 任何"离开就恢复默认"的逻辑，本身就自然满足"保留所选"。
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-reading-size', size);
  }, [theme, size]);

  // applyIdentity: 仅当调用方确认"真正走完 onboarding.complete 成功(result.ok)且 mode==='fresh'"时传 true;
  // already-completed 重放路径(即使 mode==='fresh')不传——identity 已由 bootstrap 注水,不应用本地猜测值覆盖。
  const applyOkAndEnter = async (applyIdentity: boolean) => {
    // bootstrap() 在 noProvider 时把 settingsTabOpen/activeCenterTab 写成了 settings 落地页(引导用户先配 provider)。
    // 向导走完后必须复位,否则新用户完成向导进主界面直接停在 Settings 页而非空态欢迎页。
    // closeSettings() 是 uiStore 现成 setter,一次性重置 settingsTabOpen/activeCenterTab,
    // 同时顺带清掉 settingsDetailProviderId/settingsAddProviderOpen——即第 3 步模型子步骤里
    // 可能打开过的 ProviderDetailPane/AddProviderPage 残留,避免主界面 Settings 首次打开时
    // 停在残留的子页面而不是 provider 列表。
    useUiStore.getState().closeSettings();
    const fresh = await window.kydog.invoke('settings.get');
    // recovery/already-completed 模式下本地 theme/size state 从未被用户在本次会话触碰,仍是
    // 初始默认值 'vellum'/'medium';直接用它们调 setTheme/setReadingFontSize 会覆盖 main 侧刚从
    // manifest 恢复(或本就已持久化)的用户真实选择,且 bootstrap 的持久化订阅会把这个错误值
    // 写回磁盘造成永久丢失。改用刚 settings.get 到的 fresh.ui.* ——fresh 模式下这与本地 state
    // 等价(本地 state 正是提交给 main 生成它的来源),recovery/already-completed 模式下则是正确的
    // 已恢复值,两种模式统一处理,无需按 mode 分支。
    useUiStore.getState().setTheme(fresh.ui.theme);
    useUiStore.getState().setReadingFontSize(fresh.ui.readingFontSize);
    if (applyIdentity) {
      const id = { userName: userName.trim() || 'You', agentName: agentName.trim() || 'KyDog' };
      useIdentityStore.getState().setIdentity(id);
    }
    // bootstrap 那次 skill.list 跑在 onboarding 播种**之前**，拿到的是空列表；不在这里重拉，
    // Composer 的 slash 菜单会一直空着，直到用户手动进一次 Settings 的技能页。
    // 同理重取一次 health —— 播种成没成只有主进程知道。
    await Promise.all([
      window.kydog.invoke('skill.list')
        .then((skills) => useSkillsStore.getState().setSkills(skills))
        .catch((err) => console.error('skill.list after onboarding failed', err)),
      window.kydog.invoke('skill.getSyncHealth')
        .then((h) => useUiStore.getState().setSkillSyncHealth(h))
        .catch((err) => console.error('skill.getSyncHealth after onboarding failed', err)),
    ]);
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
          telemetryEnabled,
        });
    setBusy(false);
    // applyIdentity 只在这条"真正走完 complete/resume 成功"的路径且 mode==='fresh' 时为 true——
    // 此时 userName/agentName 是本次向导里用户真实填写的值。already-completed 分支即使 mode
    // 仍是 'fresh' 也一律传 false,见 applyOkAndEnter 注释。
    if (result.ok) { await applyOkAndEnter(mode === 'fresh'); return; }
    switch (result.code) {
      case 'already-completed': await applyOkAndEnter(false); return;
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

  // Enter=下一步。只接管向导自己的文本输入(称呼两个输入框)和完成步(无输入,全局监听)——
  // 模型步内嵌的是 ProviderListSection/ApiKeyForm 等共享设置组件,它们的输入框有自己的
  // Enter 语义(比如 ApiKeyForm 是个 <form>,Enter 会触发它自己的保存),不去劫持;这天然
  // 满足"门禁未过时 Enter 无效"——门禁通过后走已可点的"下一步"按钮即可。
  const onNameInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    // IME 组合输入(如拼音候选)期间的确认回车不算"下一步"，否则中文输入法选字会被误触发跳步。
    if (e.nativeEvent.isComposing) return;
    if (e.key !== 'Enter') return;
    e.preventDefault();
    goNext();
  };
  useEffect(() => {
    if (mode !== 'fresh' || step !== 4) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.key !== 'Enter' || busy) return;
      e.preventDefault();
      void submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, step, busy]);

  if (mode === 'recovery') {
    return (
      <RecoveryFrame title={t.recoveryTitle}>
        <p className="font-serif" style={{ fontSize: 13, color: 'var(--color-ink-soft)', lineHeight: 1.7 }}>{t.recoveryBody}</p>
        {error && <ErrorLine code={error} t={t} />}
        <footer style={{ marginTop: 24 }}>
          <button data-testid="onboarding-retry" disabled={busy} onClick={() => void submit()}
            className={primaryBtnClass} style={primaryBtn}>{t.retry}</button>
        </footer>
      </RecoveryFrame>
    );
  }

  return (
    <div data-testid="onboarding-root" className="ky-paper-grain h-full w-full overflow-y-auto flex items-center justify-center"
      style={{ background: 'var(--color-paper)', color: 'var(--color-ink)' }}>
      <style>{WIZARD_STYLE}</style>
      <div style={{
        maxWidth: 860, width: '100%', margin: '0 auto', padding: '56px 24px',
        display: 'grid', gridTemplateColumns: '236px 1fr', gap: 0,
        height: 520, alignItems: 'stretch',
      }}>
        {/* 左栏：欢迎语(与吉祥物同行) + 步骤 rail——与右栏共享同一条发丝线分区、同一容器高度(520，
            与右栏一起被外层 grid 的 height+alignItems:'stretch' 撑到等高) */}
        <div style={{
          display: 'flex', flexDirection: 'column',
          paddingRight: 28, borderRight: '0.5px solid var(--color-ink-hair-soft)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* mascot content 在 SVG box 偏下，align-items:center 会显得比文字低；负 marginTop 校正
                （技巧同 WorkspaceHeader.tsx 里 KyLogo/KyMascot 同行的用法） */}
            <KyMascot size={28} style={{ marginTop: -6 }} />
            <h1 className="font-serif" style={{ fontSize: 22 }}>{t.welcome}</h1>
          </div>
          <nav style={{ marginTop: 30, display: 'flex', flexDirection: 'column', gap: 11 }}>
            {steps.map((label, i) => {
              const idx = i as Step;
              const done = idx < step;
              const current = idx === step;
              return (
                <button
                  key={i}
                  type="button"
                  data-testid={`onboarding-rail-${i}`}
                  disabled={!done}
                  onClick={done ? () => setStep(idx) : undefined}
                  className="font-mono text-left"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    background: 'transparent', border: 'none', padding: 0,
                    fontSize: 11,
                    color: done || current ? 'var(--color-ink)' : 'var(--color-ink-faint)',
                    cursor: done ? 'pointer' : 'default',
                  }}
                >
                  <span style={{ width: 10, flexShrink: 0, textAlign: 'center' }}>{done ? '✓' : current ? '●' : '○'}</span>
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* 右栏：标题(固定) → 内容区(flex:1+内部滚动，防止第 3 步 provider 列表撑高把 footer 顶跑)
            → footer(固定在列尾)。容器整体等高 520，任何一步内容再高都在内容区内部滚动。 */}
        <div style={{ minWidth: 0, minHeight: 0, paddingLeft: 36, display: 'flex', flexDirection: 'column' }}>
          {corruptNotice && (
            <p className="font-serif italic" style={{ fontSize: 12, color: 'var(--color-ink-soft)', marginBottom: 18 }}>{t.corruptNotice}</p>
          )}
          <div key={step} className="onboarding-step-fade" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <h2 className="font-serif" style={{ fontSize: 26, flexShrink: 0 }}>{stepTitle(step, t)}</h2>
            <div className="ky-scroll" style={{ marginTop: 22, flex: 1, minHeight: 0, overflowY: 'auto' }}>
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
                  <label style={{ display: 'block', marginBottom: 22 }}>
                    <span style={labelStyle}>{t.namesUserLabel}</span>
                    <OnboardingInput testId="onboarding-username" value={userName} maxLength={64}
                      placeholder={t.namesUserPlaceholder} onChange={(e) => setUserName(e.target.value)}
                      onKeyDown={onNameInputKeyDown} />
                  </label>
                  <label style={{ display: 'block' }}>
                    <span style={labelStyle}>{t.namesAgentLabel}</span>
                    <OnboardingInput testId="onboarding-agentname" value={agentName} maxLength={64}
                      placeholder={t.namesAgentPlaceholder} onChange={(e) => setAgentName(e.target.value)}
                      onKeyDown={onNameInputKeyDown} />
                  </label>
                </div>
              )}
              {step === 2 && <ModelStep notReady={llmReady ? null : t.modelNotReady} />}
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
                  <FilesGuide t={t} />
                  {error && <ErrorLine code={error} t={t} />}
                </div>
              )}
              {stepHint(step, t) && <p className="font-serif italic" style={hintStyle}>{stepHint(step, t)}</p>}
            </div>
            {/* 勾选块钉在滚动区**外面**：完成页内容本就快撑满 520 的固定高度，放进滚动区时
                实测整块被折叠线切掉大半（文案断在句子中间）。一个用户根本没看见的同意勾选，
                比没有勾选更糟。 */}
            {step === 4 && <TelemetryOptIn t={t} checked={telemetryEnabled} onChange={setTelemetryEnabled} />}
          </div>

          <footer style={{ marginTop: 'auto', paddingTop: 28, display: 'flex', alignItems: 'center', gap: 16 }}>
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
        </div>
      </div>
    </div>
  );
}

/** 第 3 步：复用 SettingsPane 的 provider 三分支(列表/新增/详情)。 */
function ModelStep({ notReady }: { notReady: string | null }) {
  const detailProviderId = useUiStore((s) => s.settingsDetailProviderId);
  const addOpen = useUiStore((s) => s.settingsAddProviderOpen);
  const openAdd = useUiStore((s) => s.openSettingsAddProvider);
  useEffect(() => { void useLlmStore.getState().refresh(); }, []);
  return (
    <div>
      {detailProviderId ? <ProviderDetailPane /> : addOpen ? <AddProviderPage /> : <ProviderListSection onAdd={openAdd} />}
      {notReady && <p data-testid="onboarding-model-notready" className="font-serif italic" style={{ fontSize: 11, color: 'var(--color-ink-soft)', marginTop: 4 }}>{notReady}</p>}
    </div>
  );
}

/** 完成页「这些文件属于你」清单：mono 路径 + sans 说明(ink-soft)，行间发丝分隔线，紧凑不留白撑高。 */
function FilesGuide({ t }: { t: Dict }) {
  return (
    <div data-testid="onboarding-files-guide" style={{ marginTop: 20 }}>
      <div className="font-mono uppercase" style={{ fontSize: 10, color: 'var(--color-ink-faint)', letterSpacing: 1.5, marginBottom: 2 }}>
        {t.filesGuideTitle}
      </div>
      {FILES_GUIDE.map(({ path, descKey }, i) => (
        <div key={path} style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 10, rowGap: 2,
          padding: '6px 0',
          borderTop: i === 0 ? 'none' : '0.5px solid var(--color-ink-hair-soft)',
        }}>
          <span className="font-mono" style={{ fontSize: 11, color: 'var(--color-ink)', flexShrink: 0 }}>{path}</span>
          <span className="font-sans" style={{ fontSize: 11.5, color: 'var(--color-ink-soft)' }}>{t[descKey]}</span>
        </div>
      ))}
      <p className="font-serif italic" style={hintStyle}>{t.filesGuideHint}</p>
    </div>
  );
}

/** 完成页的统计勾选：与关于页那个开关是同一件事，勾选框样式（accentColor）也对齐 PrivacyPanel。 */
function TelemetryOptIn({ t, checked, onChange }: { t: Dict; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      data-testid="onboarding-telemetry-block"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer',
        marginTop: 18, paddingTop: 16, borderTop: '0.5px solid var(--color-ink-hair-soft)',
        // 不参与 flex 压缩：被压扁就等于又回到了「文案被切掉」那个状态
        flexShrink: 0,
      }}
    >
      <input
        type="checkbox"
        data-testid="onboarding-telemetry"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: 'var(--color-accent, #6b8e7f)', marginTop: 2, flexShrink: 0 }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{ ...labelStyle, color: 'var(--color-ink)' }}>{t.telemetryLabel}</span>
        <span className="font-sans" style={{ display: 'block', fontSize: 11, color: 'var(--color-ink-soft)', lineHeight: 1.6, marginTop: 4 }}>
          {t.telemetryBody}
        </span>
      </span>
    </label>
  );
}

function ErrorLine({ code, t }: { code: OnboardingErrorCode; t: Dict }) {
  const msg = code === 'invalid-input' ? t.errInvalidInput : code === 'model-missing' ? t.errModelMissing : t.errSeedFailed;
  return <p data-testid="onboarding-error" role="alert" className="font-serif" style={{ fontSize: 12, color: 'var(--color-accent, #a04040)', marginTop: 12 }}>{msg}</p>;
}

/** recovery 模式:单列,主题/字号预览同样从 mount 就生效(见上方 useEffect,与 mode 无关)。 */
function RecoveryFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div data-testid="onboarding-root" className="ky-paper-grain h-full w-full overflow-y-auto flex items-center justify-center"
      style={{ background: 'var(--color-paper)', color: 'var(--color-ink)' }}>
      <div style={{ maxWidth: 560, width: '100%', padding: '64px 24px' }}>
        <h1 className="font-serif" style={{ fontSize: 28 }}>{title}</h1>
        <div style={{ marginTop: 28 }}>{children}</div>
      </div>
    </div>
  );
}
