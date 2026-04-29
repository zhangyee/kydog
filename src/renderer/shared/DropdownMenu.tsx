import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';

type Align = 'left' | 'right';
type Coords = { x: number; y: number; align: Align };

type DropdownMenuProps = {
  trigger: (params: { open: boolean; toggle: () => void; ref: Ref<HTMLElement> }) => ReactNode;
  align?: Align;
  width?: number;
  testId?: string;
  children: ReactNode;
};

export function DropdownMenu({ trigger, align = 'right', width = 220, testId, children }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const close = () => setOpen(false);
  const toggle = () => {
    if (!triggerRef.current) return;
    if (open) { setOpen(false); return; }
    const r = triggerRef.current.getBoundingClientRect();
    const gap = 4;
    setCoords({
      x: align === 'right' ? r.right : r.left,
      y: r.bottom + gap,
      align,
    });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (panelRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  return (
    <>
      {trigger({ open, toggle, ref: triggerRef as Ref<HTMLElement> })}
      {open && coords && createPortal(
        <div
          ref={panelRef}
          data-testid={testId}
          role="menu"
          style={{
            position: 'fixed',
            left: coords.align === 'left' ? coords.x : undefined,
            right: coords.align === 'right' ? window.innerWidth - coords.x : undefined,
            top: coords.y,
            width,
            background: 'var(--color-paper)',
            border: '0.5px solid var(--color-ink-hair)',
            borderRadius: 6,
            boxShadow: '0 12px 32px rgba(50,35,20,0.18), 0 2px 6px rgba(50,35,20,0.10)',
            padding: '4px 0',
            fontFamily: 'var(--font-sans)',
            zIndex: 1000,
          }}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>,
        document.body,
      )}
    </>
  );
}

export function DropdownSection({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div style={{ padding: '4px 0' }}>
      {title && (
        <div
          className="font-mono uppercase"
          style={{ fontSize: 9, letterSpacing: 1.2, color: 'var(--color-ink-faint)', padding: '4px 12px 2px' }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

export function DropdownDivider() {
  return <div style={{ height: 1, background: 'var(--color-paper-edge)', margin: '4px 0' }} />;
}

type DropdownItemProps = {
  icon?: ReactNode;
  label: string;
  shortcut?: string;
  checked?: boolean;
  destructive?: boolean;
  onClick?: () => void;
  testId?: string;
};

export function DropdownItem({ icon, label, shortcut, checked, destructive, onClick, testId }: DropdownItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      onClick={() => { onClick?.(); }}
      className="w-full flex items-center text-left transition-colors hover:bg-[color:var(--color-hover-bg)]"
      style={{
        padding: '7px 12px',
        gap: 10,
        fontSize: 12.5,
        color: destructive ? 'var(--color-accent)' : 'var(--color-ink)',
        cursor: 'pointer',
      }}
    >
      <span
        className="inline-flex items-center justify-center shrink-0"
        style={{ width: 16, height: 16, color: destructive ? 'var(--color-accent)' : 'var(--color-ink-soft)' }}
      >
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {checked && <span style={{ color: 'var(--color-ink-soft)', fontSize: 12 }}>✓</span>}
      {!checked && shortcut && (
        <span className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>{shortcut}</span>
      )}
    </button>
  );
}
