import { KyLogo, KyMascot, PanelIcon } from '../../shared';
import { useUiStore } from '../../stores/uiStore';

export function WorkspaceHeader() {
  const toggle = useUiStore((s) => s.toggleWorkspace);
  return (
    <div
      className="flex items-center"
      style={{
        padding: '14px 16px 10px',
        borderBottom: '0.5px solid var(--color-ink-hair-soft)',
      }}
    >
      <div
        style={{
          flex: 1,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          color: 'var(--color-ink)',
        }}
      >
        <KyLogo size={20} />
        {/* mascot content 在 SVG box 偏下，align-items:center 会显得比文字低 ~2-3px；负 marginTop 校正 */}
        <KyMascot size={24} style={{ marginTop: -5 }} />
      </div>
      <button
        type="button"
        data-testid="collapse-workspace"
        onClick={toggle}
        aria-label="收起左栏"
        className="w-6 h-6 inline-flex items-center justify-center rounded hover:bg-[color:var(--color-hover-bg)]"
        style={{ color: 'var(--color-ink-soft)' }}
      >
        <PanelIcon side="left" filled size={13} />
      </button>
    </div>
  );
}
