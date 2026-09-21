import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export type Placement = 'top' | 'bottom' | 'left' | 'right';

/** 提示框与锚点之间留的缝。 */
export const TOOLTIP_GAP = 6;

type AnchorRect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/**
 * 提示框贴在锚点哪一侧。定位点（fixed 的 left / top）落在锚点那条边外 GAP 处，transform 再把
 * 提示框**整个**推到那一侧：top 要往上推满自身高度（-100%），left 要往左推满自身宽度（-100%）。
 * 只推 -50% / 0 的话，提示框会从定位点往回伸，盖住锚点本身 —— top / left 以前就是这样。
 */
export function tooltipPosition(placement: Placement, r: AnchorRect): { x: number; y: number; transform: string } {
  switch (placement) {
    case 'bottom': return { x: r.left + r.width / 2, y: r.bottom + TOOLTIP_GAP, transform: 'translate(-50%, 0)' };
    case 'top': return { x: r.left + r.width / 2, y: r.top - TOOLTIP_GAP, transform: 'translate(-50%, -100%)' };
    case 'right': return { x: r.right + TOOLTIP_GAP, y: r.top + r.height / 2, transform: 'translate(0, -50%)' };
    case 'left': return { x: r.left - TOOLTIP_GAP, y: r.top + r.height / 2, transform: 'translate(-100%, -50%)' };
  }
}

type Props = {
  content: ReactNode;
  placement?: Placement;
  delayMs?: number;
  children: ReactNode;
};

export function Tooltip({ content, placement = 'bottom', delayMs = 200, children }: Props) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number; transform: string } | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const measure = () => {
    const el = wrapRef.current;
    if (!el) return;
    setCoords(tooltipPosition(placement, el.getBoundingClientRect()));
  };

  const onEnter = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { measure(); setOpen(true); }, delayMs);
  };
  const onLeave = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setOpen(false);
  };

  return (
    <>
      <span
        ref={wrapRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
        style={{ display: 'inline-flex' }}
      >
        {children}
      </span>
      {open && coords && createPortal(
        <div
          role="tooltip"
          style={{
            position: 'fixed',
            left: coords.x,
            top: coords.y,
            transform: coords.transform,
            zIndex: 1000,
            padding: '4px 8px',
            background: 'var(--color-ink)',
            color: 'var(--color-paper)',
            fontFamily: 'var(--font-sans)',
            fontSize: 11,
            lineHeight: 1.4,
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {content}
        </div>,
        document.body,
      )}
    </>
  );
}
