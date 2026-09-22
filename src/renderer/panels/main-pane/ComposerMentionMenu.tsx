import { NavIcon } from '../../shared';
import type { MentionEntry } from './mentionSearch';

type Props = {
  items: MentionEntry[];
  /** 这一次的读取结束了没有（逐级浏览读完这一层 / 按名字找读完整棵树）。 */
  done: boolean;
  highlightIndex: number;
  anchorRect: DOMRect;
  onHover: (idx: number) => void;
  onSelect: (item: MentionEntry) => void;
};

/** @ 列表（4A ③）。外观与定位照 ComposerSlashMenu。文件夹一行带文件夹图标与末尾的 `/`，选中是进入下一层。 */
export function ComposerMentionMenu({ items, done, highlightIndex, anchorRect, onHover, onSelect }: Props) {
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
          {done ? '没有匹配的文件' : '正在查找…'}
        </div>
      ) : items.map((item, i) => {
        const cut = item.rel.lastIndexOf('/');
        const isDir = item.kind === 'dir';
        return (
          <button
            key={`${item.kind}:${item.rel}`} type="button"
            data-testid={isDir ? `mention-dir-${item.rel}` : `mention-item-${item.rel}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onSelect(item); }}
            className="w-full text-left flex items-baseline"
            style={{ gap: 8, padding: '5px 14px', background: i === safe ? 'var(--color-hover-bg)' : 'transparent', border: 'none', cursor: 'pointer' }}
          >
            {isDir ? (
              <span style={{ alignSelf: 'center', display: 'inline-flex', color: 'var(--color-ink-faint)' }}>
                <NavIcon name="folder" size={12} />
              </span>
            ) : null}
            <span className="font-mono" style={{ fontSize: 12, color: 'var(--color-ink)' }}>
              {item.name}{isDir ? '/' : ''}
            </span>
            {cut >= 0 ? <span className="font-mono truncate" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>{item.rel.slice(0, cut + 1)}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
