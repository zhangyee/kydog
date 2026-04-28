import { useUiStore } from '../../stores/uiStore';
import { useSettingsStore } from '../../stores/settingsStore';

export function UserBar() {
  const open = useUiStore((s) => s.userMenuOpen);
  const toggle = useUiStore((s) => s.toggleUserMenu);
  const provider = useSettingsStore((s) => s.settings?.llm.provider);
  const userName = 'Yee Zhang';   // MVP：静态。OS userInfo 在 H' 子项目接

  return (
    <button
      type="button"
      data-testid="user-menu-trigger"
      onClick={toggle}
      className="flex items-center gap-2.5 cursor-pointer w-full text-left"
      style={{
        borderTop: '0.5px solid var(--color-ink-hair-soft)',
        padding: '10px 12px',
        background: open ? 'var(--color-paper)' : 'var(--color-paper-deep)',
        boxShadow: open ? 'inset 0 0 0 1px var(--color-accent-soft)' : 'none',
      }}
      aria-label="用户菜单"
    >
      <span
        className="font-serif italic flex items-center justify-center"
        style={{
          width: 28, height: 28, borderRadius: '50%',
          background: 'var(--color-paper-edge)',
          border: '0.5px solid var(--color-ink-hair)',
          fontSize: 13, color: 'var(--color-ink)',
        }}
      >
        {userName.slice(0, 1).toLowerCase()}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[12px] font-medium truncate" style={{ color: 'var(--color-ink)' }}>{userName}</span>
        <span className="block text-[10px] font-mono truncate" style={{ color: 'var(--color-ink-faint)' }}>
          {provider ? `${provider.name} · ${provider.model}` : '未配置 provider'}
        </span>
      </span>
      <span
        className="font-serif"
        style={{ fontSize: 14, letterSpacing: 1, color: open ? 'var(--color-ink)' : 'var(--color-ink-faint)' }}
      >
        ⋯
      </span>
    </button>
  );
}
