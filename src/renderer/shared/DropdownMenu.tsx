import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';

/** 下拉菜单与右键菜单共用的面板样式（ContextMenu 也用它）。定位字段各自补。 */
export const MENU_PANEL_STYLE: CSSProperties = {
  background: 'var(--color-paper)',
  border: '0.5px solid var(--color-ink-hair)',
  borderRadius: 6,
  boxShadow: '0 12px 32px rgba(50,35,20,0.18), 0 2px 6px rgba(50,35,20,0.10)',
  padding: '4px 0',
  fontFamily: 'var(--font-sans)',
  zIndex: 1000,
};

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
            ...MENU_PANEL_STYLE,
            position: 'fixed',
            left: coords.align === 'left' ? coords.x : undefined,
            right: coords.align === 'right' ? window.innerWidth - coords.x : undefined,
            top: coords.y,
            width,
          }}
          // portal 只搬了 DOM 节点，不搬事件路径：同 ContextMenu.tsx 的注释——这个面板在
          // React 树上仍是触发 trigger 那一行的子节点，面板上任何一次点击 / 右键 / 按下不拦
          // 住，都会接着冒泡到行上的 onClick / onContextMenu（右键「…」菜单里再右键，会在
          // 这一行上又弹出一个右键菜单）。
          onClick={(e) => { e.stopPropagation(); setOpen(false); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onMouseDown={(e) => e.stopPropagation()}
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
  /** 右侧的说明小字（例：「运行中」）。与 shortcut 占同一个位置，有 hint 时不显示 shortcut。 */
  hint?: string;
  checked?: boolean;
  destructive?: boolean;
  /** 禁用：不响应点击，也拦住冒泡，让外层面板别因为这一下关掉。 */
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
};

export function DropdownItem({ icon, label, shortcut, hint, checked, destructive, disabled, onClick, testId }: DropdownItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={testId}
      aria-disabled={disabled ? true : undefined}
      onClick={(e) => {
        if (disabled) { e.stopPropagation(); return; }
        onClick?.();
      }}
      className={`w-full flex items-center text-left transition-colors${disabled ? '' : ' hover:bg-[color:var(--color-hover-bg)]'}`}
      style={{
        padding: '7px 12px',
        gap: 10,
        fontSize: 12.5,
        color: destructive ? 'var(--color-accent)' : 'var(--color-ink)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : undefined,
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
      {!checked && hint && (
        <span data-testid="dropdown-item-hint" style={{ fontSize: 10.5, color: 'var(--color-ink-faint)' }}>{hint}</span>
      )}
      {!checked && !hint && shortcut && (
        <span data-testid="dropdown-item-shortcut" className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>{shortcut}</span>
      )}
    </button>
  );
}
