import { useUiStore } from '../../stores/uiStore';
import type { ThemeName } from '../../../shared/types';

const SWATCH_NAMES: ThemeName[] = ['vellum', 'porcelain', 'sepia', 'midnight', 'lilac'];

export function UserMenuPopover() {
  const open = useUiStore((s) => s.userMenuOpen);
  const toggle = useUiStore((s) => s.toggleUserMenu);
  const setTheme = useUiStore((s) => s.setTheme);
  const theme = useUiStore((s) => s.theme);
  const openSettings = useUiStore((s) => s.openSettings);
  if (!open) return null;
  return (
    <div
      data-testid="user-menu"
      className="absolute bottom-12 left-3 w-[248px] rounded-md border border-[color:var(--color-paper-edge)] bg-[color:var(--color-paper)] shadow-md p-2 text-sm font-sans"
      onMouseLeave={toggle}
    >
      <button
        type="button"
        data-testid="open-settings"
        className="block w-full text-left py-1.5 px-2 hover:bg-[color:var(--color-paper-edge)] rounded"
        onClick={() => { openSettings(true); toggle(); }}
      >
        账户与模型…
      </button>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="text-[color:var(--color-ink-soft)]">主题</span>
        {SWATCH_NAMES.map((name) => (
          <button
            key={name}
            data-testid={`theme-${name}`}
            aria-pressed={theme === name}
            onClick={() => setTheme(name)}
            data-theme={name}
            className={`w-4 h-4 rounded-full border ${theme === name ? 'ring-2 ring-[color:var(--color-accent)]' : ''}`}
            style={{ background: 'var(--paper)' }}
          />
        ))}
      </div>
    </div>
  );
}
