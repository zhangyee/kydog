import { useUiStore } from '../../stores/uiStore';

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
        <button
          data-testid="theme-vellum"
          aria-pressed={theme === 'vellum'}
          onClick={() => setTheme('vellum')}
          className={`w-4 h-4 rounded-full border ${theme === 'vellum' ? 'ring-2 ring-[color:var(--color-accent)]' : ''}`}
          style={{ background: 'oklch(0.975 0.008 85)' }}
        />
        <button
          data-testid="theme-midnight"
          aria-pressed={theme === 'midnight'}
          onClick={() => setTheme('midnight')}
          className={`w-4 h-4 rounded-full border ${theme === 'midnight' ? 'ring-2 ring-[color:var(--color-accent)]' : ''}`}
          style={{ background: 'oklch(0.24 0.018 248)' }}
        />
      </div>
    </div>
  );
}
