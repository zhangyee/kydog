// src/renderer/panels/main-pane/InputPillSlashMenu.tsx
import type { SkillMenuItem } from './skillMenuItems';

type Props = {
  items: SkillMenuItem[];
  highlightIndex: number;
  anchorRect: DOMRect;
  onHover: (idx: number) => void;
  onSelect: (item: SkillMenuItem) => void;
};

export function InputPillSlashMenu({ items, highlightIndex, anchorRect, onHover, onSelect }: Props) {
  if (items.length === 0) return null;
  return (
    <div
      data-testid="slash-menu"
      style={{
        position: 'fixed',
        left: anchorRect.left,
        bottom: window.innerHeight - anchorRect.top + 6,
        background: 'var(--color-paper)',
        border: '0.5px solid var(--color-ink-hair-soft)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
        padding: '4px 0',
        minWidth: 320,
        maxHeight: 280,
        overflowY: 'auto',
        zIndex: 70,
      }}
      className="ky-scroll"
    >
      {items.map((it, i) => (
        <button
          key={it.name}
          type="button"
          data-testid={`slash-item-${it.name.slice(1)}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => { e.preventDefault(); onSelect(it); }}
          className="font-serif w-full text-left"
          style={{
            padding: '6px 14px',
            background: i === highlightIndex ? 'var(--color-hover-bg)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            gap: 10,
            alignItems: 'baseline',
          }}
        >
          <span className="font-mono" style={{ fontSize: 12, color: 'var(--color-ink)' }}>
            {it.name}
          </span>
          <span style={{ fontSize: 12, color: 'var(--color-ink-soft)' }}>
            {it.title}
          </span>
        </button>
      ))}
    </div>
  );
}
