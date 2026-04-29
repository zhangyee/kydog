import { useUiStore } from '../../stores/uiStore';
import { PanelIcon } from '../../shared';

export function InspectorHeader() {
  const toggle = useUiStore((s) => s.toggleInspector);
  return (
    <div
      className="flex items-center font-mono uppercase"
      style={{
        padding: '10px 14px 8px',
        borderBottom: '0.5px solid var(--color-ink-hair-soft)',
        fontSize: 10, fontWeight: 600,
        color: 'var(--color-ink-faint)', letterSpacing: 1.2,
      }}
    >
      <span className="flex-1">检视 Inspector</span>
      <button
        type="button"
        data-testid="collapse-inspector"
        onClick={toggle}
        aria-label="收起右栏"
        className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[color:var(--color-hover-bg)]"
        style={{ color: 'var(--color-ink-soft)' }}
      >
        <PanelIcon side="right" filled size={13} />
      </button>
    </div>
  );
}
