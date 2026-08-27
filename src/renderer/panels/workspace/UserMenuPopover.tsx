import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSkillsStore } from '../../stores/skillsStore';
import type { ReadingFontSize, SettingsFile, ThemeName } from '../../../shared/types';

const SWATCHES: Array<{ name: ThemeName; label: string }> = [
  { name: 'vellum',    label: 'Vellum' },
  { name: 'porcelain', label: 'Porcelain' },
  { name: 'sepia',     label: 'Sepia' },
  { name: 'midnight',  label: 'Midnight' },
  { name: 'lilac',     label: 'Lilac' },
];

export function UserMenuPopover() {
  const open = useUiStore((s) => s.userMenuOpen);
  const close = () => useUiStore.setState({ userMenuOpen: false });
  const setTheme = useUiStore((s) => s.setTheme);
  const theme = useUiStore((s) => s.theme);
  const readingFontSize = useUiStore((s) => s.readingFontSize);
  const setReadingFontSize = useUiStore((s) => s.setReadingFontSize);
  const openSettings = useUiStore((s) => s.openSettings);
  const panelRef = useRef<HTMLDivElement>(null);

  // 语言的唯一真相是 settings，不留本地副本：locale.set 是个事务，失败时它带回的是**旧**
  // locale，直接覆盖 store 就把界面钉回旧语言了；乐观地先改本地 state 反而要写一条回滚。
  const locale = useSettingsStore((s) => s.settings?.ui.locale ?? 'zh');
  const [localeBusy, setLocaleBusy] = useState(false);
  const [localeError, setLocaleError] = useState<string | null>(null);

  const applyLocale = async (next: SettingsFile['ui']['locale']) => {
    if (next === locale || localeBusy) return;
    setLocaleBusy(true);
    setLocaleError(null);
    try {
      const r = await window.kydog.invoke('locale.set', { locale: next });
      // settings / skills 一律用主进程返回值覆盖，界面因此不会和磁盘脱节。
      // skills 尤其不能省：bootstrap 拿到的是旧语言的 description，换完树它自己不会刷新。
      useSettingsStore.getState().setSettings(r.settings);
      useSkillsStore.getState().setSkills(r.skills);
      // health store 只在这一轮真的跑过同步时才写。rejected / unchanged 都没碰 skill 树，
      // 拿它们去写会让 Settings 显示一条与磁盘现状相反、且永远不会消失的横幅。
      switch (r.outcome.kind) {
        case 'applied':
          useUiStore.getState().setSkillSyncHealth(r.outcome.sync);
          break;
        case 'failed':
          // 两个字段各喂各的：health store 写的是**重投影之后**树的健康度（成功还原时就是
          // ok），内联提示写的才是「这次为什么没切成」。反过来把 sync 写进 health store，
          // Settings 会显示「skill 同步失败」，而磁盘是完好的旧语言树、主进程也答 ok。
          useUiStore.getState().setSkillSyncHealth(r.outcome.health);
          setLocaleError(r.outcome.sync.message);
          break;
        case 'rejected':
          // 只走内联提示：这不是同步失败，是「现在不能切」。
          setLocaleError(r.outcome.message);
          break;
        case 'unchanged':
          break;
      }
    } catch (e) {
      setLocaleError(String((e as Error)?.message ?? e));
    } finally {
      setLocaleBusy(false);
    }
  };

  // 菜单关掉时把失败原因清掉。这个组件是**无条件挂在** WorkspacePanel 上的（内部靠
  // `if (!open) return null` 决定画不画），React 不会卸载它，useState 全都留着 ——
  // 不主动清，「有任务正在运行」会在 run 早就结束、此刻切换明明能成的时候原样再出现一次。
  useEffect(() => {
    if (!open) setLocaleError(null);
  }, [open]);

  // Esc / 外部点击关闭菜单（键盘与指针可访问性）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('[data-testid="user-menu-trigger"]')) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', onClick);
    };
  }, [open]);

  if (!open) return null;
  const themeMeta = SWATCHES.find(s => s.name === theme);

  return (
    <div
      ref={panelRef}
      data-testid="user-menu"
      className="absolute font-sans"
      style={{
        left: 8, bottom: 56, width: 248,
        background: 'var(--color-paper)',
        border: '0.5px solid var(--color-ink-hair)',
        borderRadius: 5,
        boxShadow: '0 12px 32px rgba(50,35,20,0.18), 0 2px 6px rgba(50,35,20,0.10)',
        padding: '4px 0', zIndex: 50,
      }}
    >
      <ActionRow
        label="模型与提供商"
        summary="登录订阅或填入 API Key"
        testId="open-settings"
        onClick={() => { openSettings('provider'); close(); }}
      />
      <ActionRow
        label="文献检索密钥"
        summary="文献源 API Key 与联系邮箱"
        testId="open-research"
        onClick={() => { openSettings('research'); close(); }}
      />

      <div style={{ height: 1, background: 'var(--color-paper-edge)', margin: '6px 0' }} />

      {/* 语言 */}
      <SectionLabel>语言 · Language</SectionLabel>
      <div className="flex gap-1.5" style={{ padding: '2px 14px 8px' }}>
        {(['zh', 'en'] as const).map((l) => (
          <button
            key={l}
            type="button"
            data-testid={`locale-${l}`}
            aria-pressed={locale === l}
            disabled={localeBusy}
            onClick={() => void applyLocale(l)}
            className="cursor-pointer"
            style={{
              padding: '3px 10px', borderRadius: 2,
              border: locale === l ? '1px solid var(--color-ink)' : '0.5px solid var(--color-ink-hair-soft)',
              background: locale === l ? 'var(--color-paper-deep)' : 'transparent',
              fontSize: 11, color: 'var(--color-ink)',
              opacity: localeBusy ? 0.5 : 1,
            }}
          >{l === 'zh' ? '中文' : 'English'}</button>
        ))}
      </div>
      {/* 换树是真实文件 IO，失败原因就在点击处说清楚 —— 让用户去 Settings 里找太远了 */}
      {localeError && (
        <div
          data-testid="locale-switch-error"
          style={{ padding: '0 14px 8px', fontSize: 10.5, lineHeight: 1.5, color: 'var(--color-accent)' }}
        >{localeError}</div>
      )}

      {/* 主题 */}
      <SectionLabel>主题</SectionLabel>
      <div className="flex items-center gap-2" style={{ padding: '4px 14px 8px' }}>
        {SWATCHES.map((s) => (
          <button
            key={s.name}
            type="button"
            data-testid={`theme-${s.name}`}
            data-theme={s.name}
            aria-pressed={theme === s.name}
            onClick={() => setTheme(s.name)}
            style={{
              width: 16, height: 16, borderRadius: '50%',
              background: 'var(--paper)',
              border: theme === s.name ? '2px solid var(--color-ink)' : '0.5px solid var(--color-ink-hair)',
              boxShadow: 'inset 0 1px 1px rgba(0,0,0,0.08)',
              cursor: 'pointer',
            }}
            title={s.label}
          />
        ))}
        <span style={{ flex: 1 }} />
        <span className="font-serif italic" style={{ fontSize: 10.5, color: 'var(--color-ink-faint)' }}>{themeMeta?.label}</span>
      </div>

      {/* 字号 */}
      <SectionLabel>字号</SectionLabel>
      <div className="flex gap-1.5" style={{ padding: '2px 14px 8px' }}>
        {(
          [
            { id: 'small',  label: '小' },
            { id: 'medium', label: '中' },
            { id: 'large',  label: '大' },
          ] as Array<{ id: ReadingFontSize; label: string }>
        ).map((opt) => (
          <button
            key={opt.id}
            type="button"
            data-testid={`reading-size-${opt.id}`}
            aria-pressed={readingFontSize === opt.id}
            onClick={() => setReadingFontSize(opt.id)}
            className="cursor-pointer"
            style={{
              padding: '3px 14px', borderRadius: 2,
              border: readingFontSize === opt.id
                ? '1px solid var(--color-ink)'
                : '0.5px solid var(--color-ink-hair-soft)',
              background: readingFontSize === opt.id ? 'var(--color-paper-deep)' : 'transparent',
              fontSize: 11, color: 'var(--color-ink)',
            }}
          >{opt.label}</button>
        ))}
      </div>

      <div style={{ height: 1, background: 'var(--color-paper-edge)', margin: '6px 0' }} />
      <ActionRow label="支持作者" testId="menu-donate" onClick={() => { openSettings('donate'); close(); }} />
      <ActionRow label="关于" testId="menu-about" onClick={() => { openSettings('about'); close(); }} />
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="font-mono uppercase"
      style={{ fontSize: 9, letterSpacing: 1.4, color: 'var(--color-ink-faint)', padding: '4px 14px 2px' }}
    >{children}</div>
  );
}

function ActionRow({
  label,
  summary,
  badge,
  onClick,
  testId,
}: {
  label: string;
  summary?: string;
  badge?: string;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex items-center gap-2.5 w-full text-left cursor-pointer hover:bg-[color:var(--color-hover-bg)]"
      style={{ padding: '9px 14px', fontSize: 12.5, color: 'var(--color-ink)', fontFamily: 'var(--font-sans)' }}
    >
      <span className="flex-1 min-w-0">
        <span style={{ display: 'block' }}>
          {label}
          {badge && (
            <span
              className="font-mono"
              style={{
                marginLeft: 8,
                padding: '1px 5px',
                background: 'var(--color-moss)',
                color: 'var(--color-paper)',
                borderRadius: 2,
                fontSize: 8.5,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
              }}
            >
              {badge}
            </span>
          )}
        </span>
        {summary && (
          <span
            className="block font-serif italic truncate"
            style={{ marginTop: 2, fontSize: 10.5, color: 'var(--color-ink-soft)' }}
          >
            {summary}
          </span>
        )}
      </span>
      <span className="font-serif text-[14px]" style={{ color: 'var(--color-ink-faint)' }}>›</span>
    </button>
  );
}
