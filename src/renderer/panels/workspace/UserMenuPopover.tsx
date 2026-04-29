import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ThemeName } from '../../../shared/types';

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
  const openSettings = useUiStore((s) => s.openSettings);
  const provider = useSettingsStore((s) => s.settings?.llm.provider);
  const panelRef = useRef<HTMLDivElement>(null);

  // 语言 / 字体 / 字号：本阶段仅本地 state；H' 子项目接持久化
  const [locale, setLocale] = useState<'zh' | 'en'>('zh');
  const [fontSize, setFontSize] = useState(15);

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
  const providerSummary = provider
    ? `${provider.name} · ${provider.model}`
    : '配置模型、Base URL 与 API Key';

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
        summary={providerSummary}
        badge={provider ? '已配置' : undefined}
        testId="open-settings"
        onClick={() => { openSettings('provider'); close(); }}
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
            onClick={() => setLocale(l)}
            className="cursor-pointer"
            style={{
              padding: '3px 10px', borderRadius: 2,
              border: locale === l ? '1px solid var(--color-ink)' : '0.5px solid var(--color-ink-hair-soft)',
              background: locale === l ? 'var(--color-paper-deep)' : 'transparent',
              fontSize: 11, color: 'var(--color-ink)',
            }}
          >{l === 'zh' ? '中文' : 'English'}</button>
        ))}
      </div>

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

      {/* 字体、字号（visual-only） */}
      <SectionLabel>字体、字号</SectionLabel>
      <div style={{ padding: '2px 14px 4px' }}>
        <button
          type="button"
          className="flex items-center gap-2 w-full cursor-pointer"
          style={{
            padding: '6px 0 7px',
            borderBottom: '0.5px solid var(--color-ink-hair-soft)',
            fontSize: 12.5,
            color: 'var(--color-ink)',
          }}
        >
          <span className="font-serif italic" style={{ color: 'var(--color-ink-soft)' }}>Aa</span>
          <span className="flex-1 text-left">思源宋体</span>
          <span className="font-mono text-[10px]" style={{ color: 'var(--color-ink-faint)' }}>▾</span>
        </button>
      </div>
      <div className="flex items-center gap-2.5" style={{ padding: '2px 14px 8px' }}>
        <span className="font-serif text-[9px]" style={{ color: 'var(--color-ink-faint)' }}>A</span>
        <input
          type="range" min={10} max={20} value={fontSize}
          onChange={(e) => setFontSize(Number(e.target.value))}
          className="flex-1"
          aria-label="字号"
          style={{ accentColor: 'var(--color-ink-soft)' }}
        />
        <span className="font-serif text-[14px]" style={{ color: 'var(--color-ink-faint)' }}>A</span>
        <span className="font-mono text-[10px] w-6 text-right" style={{ color: 'var(--color-ink-soft)' }}>{fontSize}</span>
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
      className="flex items-center gap-2.5 w-full text-left cursor-pointer hover:bg-[color:var(--color-paper-edge)]"
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
