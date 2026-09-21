type Props = {
  items: string[];
  indexed: boolean;
  highlightIndex: number;
  anchorRect: DOMRect;
  onHover: (idx: number) => void;
  onSelect: (path: string) => void;
};

/** @ 列表（4A ③）。外观与定位照 ComposerSlashMenu。 */
export function ComposerMentionMenu({ items, indexed, highlightIndex, anchorRect, onHover, onSelect }: Props) {
  const safe = Math.min(Math.max(highlightIndex, 0), Math.max(items.length - 1, 0));
  return (
    <div
      data-testid="mention-menu" className="ky-scroll"
      style={{
        position: 'fixed', left: anchorRect.left, bottom: window.innerHeight - anchorRect.top + 6,
        background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair-soft)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)', padding: '4px 0', minWidth: 320, maxHeight: 320, overflowY: 'auto', zIndex: 70,
      }}
    >
      {items.length === 0 ? (
        <div className="font-sans" style={{ padding: '6px 14px', fontSize: 12, color: 'var(--color-ink-faint)' }}>
          {indexed ? '没有匹配的文件' : '正在索引项目文件…'}
        </div>
      ) : items.map((p, i) => {
        const cut = p.lastIndexOf('/');
        return (
          <button
            key={p} type="button" data-testid={`mention-item-${p}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onSelect(p); }}
            className="w-full text-left flex items-baseline"
            style={{ gap: 8, padding: '5px 14px', background: i === safe ? 'var(--color-hover-bg)' : 'transparent', border: 'none', cursor: 'pointer' }}
          >
            <span className="font-mono" style={{ fontSize: 12, color: 'var(--color-ink)' }}>{cut < 0 ? p : p.slice(cut + 1)}</span>
            {cut >= 0 ? <span className="font-mono truncate" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>{p.slice(0, cut + 1)}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
