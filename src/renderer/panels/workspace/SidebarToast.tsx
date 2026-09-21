import { useEffect, useState } from 'react';
import { useToastStore } from '../../stores/toastStore';

/** 提示停留的时长。指针停在上面时不计时。 */
export const TOAST_MS = 8000;

/**
 * 左栏底部（「设置」上方）的提示。归档后的「撤销」是搜索上线前误归档唯一的找回途径
 * （spec 2026-09-21-thread-archive-design §1、§2.4），别拿它当可有可无的装饰删掉。
 * 挂在 WorkspacePanel 里（它是 position: relative），只有左栏用它。
 */
export function SidebarToast() {
  const toast = useToastStore((s) => s.toast);
  const dismiss = useToastStore((s) => s.dismiss);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!toast || hovered) return;
    const timer = setTimeout(dismiss, TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast?.id, hovered]);

  if (!toast) return null;
  return (
    <div
      role="status"
      data-testid="sidebar-toast"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="font-sans"
      style={{
        position: 'absolute', left: 12, right: 12, bottom: 48, zIndex: 20,
        display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px',
        background: 'var(--color-ink)', color: 'var(--color-paper)',
        borderRadius: 4, fontSize: 12, lineHeight: '18px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
      }}
    >
      <span className="flex-1 min-w-0 truncate">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          data-testid="sidebar-toast-action"
          onClick={() => { const run = toast.action!.run; dismiss(); run(); }}
          style={{ fontWeight: 500, textDecoration: 'underline', textUnderlineOffset: 2, color: 'inherit', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}
