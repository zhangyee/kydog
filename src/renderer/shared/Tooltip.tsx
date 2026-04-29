import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Placement = 'top' | 'bottom' | 'left' | 'right';

type Props = {
  content: ReactNode;
  placement?: Placement;
  delayMs?: number;
  children: ReactNode;
};

export function Tooltip({ content, placement = 'bottom', delayMs = 200, children }: Props) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const measure = () => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 6;
    if (placement === 'bottom') setCoords({ x: r.left + r.width / 2, y: r.bottom + gap });
    else if (placement === 'top') setCoords({ x: r.left + r.width / 2, y: r.top - gap });
    else if (placement === 'right') setCoords({ x: r.right + gap, y: r.top + r.height / 2 });
    else setCoords({ x: r.left - gap, y: r.top + r.height / 2 });
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
            transform: placement === 'bottom' || placement === 'top' ? 'translate(-50%, 0)' : 'translate(0, -50%)',
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
