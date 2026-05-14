import type { SkillEntry } from '../../../shared/types';

type Props = {
  items: SkillEntry[];
  highlightIndex: number;
  anchorRect: DOMRect;
  onHover: (idx: number) => void;
  onSelect: (item: SkillEntry) => void;
};

const LIST_MIN_WIDTH = 240;
const DESC_MAX_WIDTH = 320;
const GAP_X = 8;

export function InputPillSlashMenu({ items, highlightIndex, anchorRect, onHover, onSelect }: Props) {
  if (items.length === 0) return null;
  const safeIndex = Math.min(Math.max(highlightIndex, 0), items.length - 1);
  const highlighted = items[safeIndex];
  const baseLeft = anchorRect.left;
  const baseBottom = window.innerHeight - anchorRect.top + 6;
  return (
    <>
      <div
        data-testid="slash-menu"
        style={{
          position: 'fixed',
          left: baseLeft,
          bottom: baseBottom,
          background: 'var(--color-paper)',
          border: '0.5px solid var(--color-ink-hair-soft)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
          padding: '4px 0',
          minWidth: LIST_MIN_WIDTH,
          maxHeight: 320,
          overflowY: 'auto',
          zIndex: 70,
        }}
        className="ky-scroll"
      >
        {items.map((it, i) => (
          <button
            key={it.name}
            type="button"
            data-testid={`slash-item-${it.name}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onSelect(it); }}
            className="font-mono w-full text-left"
            style={{
              padding: '5px 14px',
              background: i === safeIndex ? 'var(--color-hover-bg)' : 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              color: 'var(--color-ink)',
              display: 'block',
            }}
          >
            /{it.name}
          </button>
        ))}
      </div>
      {highlighted ? (
        <div
          data-testid="slash-menu-desc"
          style={{
            position: 'fixed',
            left: baseLeft + LIST_MIN_WIDTH + GAP_X,
            bottom: baseBottom,
            maxWidth: DESC_MAX_WIDTH,
            background: 'var(--color-paper)',
            border: '0.5px solid var(--color-ink-hair-soft)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            padding: '10px 14px',
            fontSize: 12,
            color: 'var(--color-ink-soft)',
            lineHeight: 1.5,
            zIndex: 70,
            pointerEvents: 'none',
          }}
        >
          <div
            className="font-mono"
            style={{ fontSize: 11, color: 'var(--color-ink)', marginBottom: 4 }}
          >
            /{highlighted.name}
          </div>
          <div>{highlighted.description}</div>
        </div>
      ) : null}
    </>
  );
}
