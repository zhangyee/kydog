import { useUiStore } from '../../stores/uiStore';

export function CollapseButton({ target }: { target: 'workspace' | 'inspector' }) {
  const toggle = useUiStore((s) => target === 'workspace' ? s.toggleWorkspace : s.toggleInspector);
  return (
    <button
      type="button"
      data-testid={`collapse-${target}`}
      className="text-xs text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)] px-1"
      onClick={toggle}
      aria-label={`折叠 ${target}`}
    >
      ⇤
    </button>
  );
}
