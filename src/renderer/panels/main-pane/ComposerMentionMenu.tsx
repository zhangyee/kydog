import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NavIcon } from '../../shared';
import type { MentionEntry } from './mentionSearch';
import { MENTION_OVERSCAN, MENTION_ROW_HEIGHT, mentionMenuWidth, mentionViewportHeight, revealScrollTop, visibleRange } from './mentionWindow';

type Props = {
  items: MentionEntry[];
  /** 这一次的读取结束了没有（逐级浏览读完这一层 / 按名字找读完整棵树）。 */
  done: boolean;
  highlightIndex: number;
  anchorRect: DOMRect;
  onHover: (idx: number) => void;
  onSelect: (item: MentionEntry) => void;
};

const ROW = MENTION_ROW_HEIGHT;
const ELLIPSIS = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } as const;

/**
 * @ 列表（4A ③）。外观与定位照 ComposerSlashMenu。文件夹一行带文件夹图标与末尾的 `/`，选中是进入下一层。
 *
 * 条目数不设上限（逐级浏览一层可能就有成千上万条），但只画滚动视口里的行，上下用占位撑开（spec §3.5，
 * 算术在 mentionWindow.ts）。高亮一挪（↑↓、或随读随进的结果把它挤到别的位置）就把它滚进视野。
 */
export function ComposerMentionMenu({ items, done, highlightIndex, anchorRect, onHover, onSelect }: Props) {
  const safe = Math.min(Math.max(highlightIndex, 0), Math.max(items.length - 1, 0));
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const viewportHeight = mentionViewportHeight(items.length);
  const { start, end } = visibleRange({ scrollTop, viewportHeight, rowHeight: ROW, count: items.length, overscan: MENTION_OVERSCAN });

  // 行按 [items, start, end, safe] 记住：父组件每次渲染都会给新的回调，它们不进 deps，经 ref 取最新的。
  const handlers = useRef({ onHover, onSelect });
  handlers.current = { onHover, onSelect };

  const highlightedRel = items[safe]?.rel;
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = revealScrollTop({ scrollTop, viewportHeight, rowHeight: ROW, index: safe });
    if (next === scrollTop) return;
    el.scrollTop = next;
    setScrollTop(next);
    // 只在高亮挪动时滚：随读随进的结果不该把用户自己滚开的列表拽回去。
  }, [safe, highlightedRel]);

  const rows = useMemo(() => items.slice(start, end).map((item, k) => {
    const i = start + k;
    const cut = item.rel.lastIndexOf('/');
    const isDir = item.kind === 'dir';
    return (
      <button
        key={`${item.kind}:${item.rel}`} type="button"
        data-testid={isDir ? `mention-dir-${item.rel}` : `mention-item-${item.rel}`}
        title={item.rel}
        onMouseEnter={() => handlers.current.onHover(i)}
        onMouseDown={(e) => { e.preventDefault(); handlers.current.onSelect(item); }}
        className="w-full text-left flex items-baseline"
        style={{
          gap: 8, height: ROW, boxSizing: 'border-box', padding: '5px 14px', lineHeight: '18px', overflow: 'hidden', whiteSpace: 'nowrap',
          background: i === safe ? 'var(--color-hover-bg)' : 'transparent', border: 'none', cursor: 'pointer',
        }}
      >
        {isDir ? (
          <span style={{ alignSelf: 'center', display: 'inline-flex', flexShrink: 0, color: 'var(--color-ink-faint)' }}>
            <NavIcon name="folder" size={12} />
          </span>
        ) : null}
        {/* 宽度固定：名字与所在目录都可能很长，省略号截断；目录先让位（缩得快得多），名字尽量留全 */}
        <span className="font-mono" style={{ ...ELLIPSIS, flexShrink: 1, fontSize: 12, color: 'var(--color-ink)' }}>
          {item.name}{isDir ? '/' : ''}
        </span>
        {cut >= 0 ? <span className="font-mono" style={{ ...ELLIPSIS, flexShrink: 100, fontSize: 10, color: 'var(--color-ink-faint)' }}>{item.rel.slice(0, cut + 1)}</span> : null}
      </button>
    );
  }), [items, start, end, safe]);

  return (
    <div
      data-testid="mention-menu"
      style={{
        position: 'fixed', left: anchorRect.left, bottom: window.innerHeight - anchorRect.top + 6,
        background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair-soft)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.08)', padding: '4px 0', zIndex: 70,
        width: mentionMenuWidth(anchorRect.left, window.innerWidth), boxSizing: 'border-box',
      }}
    >
      {items.length === 0 ? (
        <div className="font-sans" style={{ padding: '6px 14px', fontSize: 12, color: 'var(--color-ink-faint)' }}>
          {done ? '没有匹配的文件' : '正在查找…'}
        </div>
      ) : (
        <div
          ref={scrollerRef} data-testid="mention-scroll" className="ky-scroll"
          style={{ height: viewportHeight, overflowY: 'auto' }}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div data-testid="mention-spacer-top" style={{ height: start * ROW }} />
          {rows}
          <div data-testid="mention-spacer-bottom" style={{ height: (items.length - end) * ROW }} />
        </div>
      )}
    </div>
  );
}
