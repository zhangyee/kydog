import { useUiStore } from '../../stores/uiStore';
import { NavPill } from './NavPill';

export function UserBar() {
  const open = useUiStore((s) => s.userMenuOpen);
  const toggle = useUiStore((s) => s.toggleUserMenu);

  return (
    <div
      style={{
        padding: '6px 6px 8px',
        background: 'var(--color-paper-deep)',
      }}
    >
      <NavPill
        icon="settings-2"
        label="设置"
        shortcut="..."
        selected={open}
        onClick={toggle}
        testId="user-menu-trigger"
      />
    </div>
  );
}
