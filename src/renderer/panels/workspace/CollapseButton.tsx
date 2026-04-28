import { useUiStore } from '../../stores/uiStore';

export function CollapseButton({ target }: { target: 'workspace' | 'inspector' }) {
  const toggle = useUiStore((s) => target === 'workspace' ? s.toggleWorkspace : s.toggleInspector);
  const collapsed = useUiStore((s) => target === 'workspace' ? s.workspaceCollapsed : s.inspectorCollapsed);
  const glyph = target === 'workspace'
    ? (collapsed ? '⇥' : '⇤')
    : (collapsed ? '⇤' : '⇥');
  return (
    <button
      type="button"
      data-testid={`collapse-${target}`}
      className="text-xs text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)] px-1"
      onClick={toggle}
      aria-label={collapsed ? `展开 ${target}` : `折叠 ${target}`}
    >
      {glyph}
    </button>
  );
}
