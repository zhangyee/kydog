import { useUiStore } from '../../stores/uiStore';

export function UserBar() {
  const toggle = useUiStore((s) => s.toggleUserMenu);
  return (
    <div className="h-10 px-3 flex items-center justify-between border-t border-[color:var(--color-paper-edge)]">
      <span className="text-sm font-sans text-[color:var(--color-ink)]">Yee Zhang</span>
      <button
        type="button"
        data-testid="user-menu-trigger"
        className="text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)] px-1"
        onClick={toggle}
        aria-label="用户菜单"
      >
        ⋯
      </button>
    </div>
  );
}
