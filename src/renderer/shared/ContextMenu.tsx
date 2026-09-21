import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MENU_PANEL_STYLE } from './DropdownMenu';
import { placeMenu } from './placeMenu';

type Props = {
  /** 指针位置（clientX / clientY）。 */
  at: { x: number; y: number };
  width?: number;
  testId?: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * 锚在一个点上的菜单（右键）。子项直接用 DropdownItem / DropdownSection / DropdownDivider。
 *
 * Esc 挂在 window 的**捕获**阶段并 preventDefault：左栏多选的 Esc 监听在冒泡阶段、跳过
 * defaultPrevented 的事件，于是菜单开着时第一下 Esc 只关菜单（spec 2026-09-21-thread-archive-design §4.4）。
 * 两者都挂在 window 上，同阶段只按注册先后执行，靠不住，所以用阶段分先后。
 */
export function ContextMenu({ at, width = 200, testId, onClose, children }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: at.x, top: at.y });

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(placeMenu(at, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [at.x, at.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (t instanceof Node && panelRef.current?.contains(t)) return;
      onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onBlur);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      data-testid={testId}
      style={{ ...MENU_PANEL_STYLE, position: 'fixed', left: pos.left, top: pos.top, width }}
      onClick={onClose}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}
