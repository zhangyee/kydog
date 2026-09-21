import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { dispatchCommentBoxKey } from '../composerHelpers';
import { PANEL_SHADOW } from '../pdf/PdfToolCard';

export function placeCommentBox(
  anchor: { left: number; top: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
  margin = 8,
): { left: number; top: number } {
  const left = Math.min(Math.max(margin, anchor.left), Math.max(margin, viewport.width - margin - size.width));
  const below = anchor.bottom + gap;
  const top = below + size.height <= viewport.height - margin ? below : Math.max(margin, anchor.top - gap - size.height);
  return { left, top };
}

type Props = {
  quote: string;
  targetTitle: string;
  anchor: { left: number; top: number; bottom: number };
  onSubmit: (note: string) => void;
  onCancel: () => void;
};

/**
 * 就地批注框（2A ①）。只有 取消 / Esc / 添加 能关掉它 —— 点编辑器别处不关，免得写了一半的批注
 * 丢掉（spec §2.2）。目标对话由调用方在弹框那一刻定下，写在说明行里。
 */
export function CommentBox({ quote, targetTitle, anchor, onSubmit, onCancel }: Props) {
  const [note, setNote] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos(placeCommentBox(anchor, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [anchor]);
  // 定位落地后再显式抢一次焦点（双保险）：`autoFocus` 在 React 挂载子节点那一刻就跑，早于
  // 这个父组件的定位 effect；这段时间框还用 `visibility: hidden` 挡着的话，Chromium 直接
  // 不给隐藏元素对焦——焦点留在 ProseMirror 里、选区还在，敲的字会把选中的原文吃掉，
  // ⌘↵ / Esc 也传去了编辑器而不是这个框。改用 opacity 藏（见下面 style），对焦不受影响；
  // 这里再补一次显式 focus，不依赖 autoFocus 的时序。
  useLayoutEffect(() => {
    if (pos) inputRef.current?.focus();
  }, [pos]);
  const submitKey = window.kydog.platform === 'darwin' ? '⌘↵' : 'Ctrl+↵';
  return createPortal(
    <div
      ref={ref} data-testid="comment-box"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed', left: pos?.left ?? anchor.left, top: pos?.top ?? anchor.bottom + 8,
        opacity: pos ? 1 : 0, pointerEvents: pos ? 'auto' : 'none', width: 320, zIndex: 80, padding: 10,
        background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)', borderRadius: 6, boxShadow: PANEL_SHADOW,
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        className="font-serif"
        style={{
          fontSize: 12, color: 'var(--color-ink-soft)', borderLeft: '2px solid var(--color-marginalia)', paddingLeft: 8, marginBottom: 8,
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}
      >{quote}</div>
      <textarea
        ref={inputRef}
        data-testid="comment-box-input" autoFocus rows={3} value={note}
        placeholder="写下批注（可留空）"
        onChange={(e) => setNote(e.target.value)}
        onInput={(e) => { const el = e.currentTarget; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 200)}px`; }}
        onKeyDown={(e) => {
          const k = dispatchCommentBoxKey({ key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
          if (k === 'submit') { e.preventDefault(); onSubmit(note); }
          else if (k === 'cancel') { e.preventDefault(); e.stopPropagation(); onCancel(); }
        }}
        className="font-serif"
        style={{
          width: '100%', resize: 'none', fontSize: 13, lineHeight: 1.5, color: 'var(--color-ink)',
          background: 'transparent', border: '0.5px solid var(--color-ink-hair)', borderRadius: 4, padding: '6px 8px', outline: 'none',
        }}
      />
      <div className="flex items-center" style={{ gap: 8, marginTop: 8 }}>
        {/* 拼成一个字符串再渲染：整句是一个文本节点（单测按整句断言）。 */}
        <span className="truncate" style={{ flex: 1, fontSize: 11, color: 'var(--color-ink-faint)' }}>
          {`进「${targetTitle}」的输入框 · ${submitKey}`}
        </span>
        <button type="button" data-testid="comment-box-cancel" onClick={onCancel} style={{ fontSize: 12, color: 'var(--color-ink-soft)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
          取消
        </button>
        <button
          type="button" data-testid="comment-box-add" onClick={() => onSubmit(note)}
          style={{ fontSize: 12, fontWeight: 500, padding: '3px 12px', borderRadius: 3, background: 'var(--color-accent)', color: 'var(--color-paper)', border: 'none', cursor: 'pointer' }}
        >添加</button>
      </div>
    </div>,
    document.body,
  );
}
