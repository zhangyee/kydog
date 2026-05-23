import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  onConfirm,
  onCancel,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  return createPortal(
    <div
      data-testid="confirm-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'oklch(0 0 0 / 0.32)' }}
      onClick={onCancel}
    >
      <div
        className="flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 360, padding: '20px 22px', borderRadius: 4,
          background: 'var(--color-paper)',
          border: '0.5px solid var(--color-ink-hair)',
          boxShadow: '0 8px 28px oklch(0 0 0 / 0.22)',
        }}
      >
        <div
          className="font-serif"
          style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-ink)', marginBottom: message ? 6 : 18 }}
        >{title}</div>
        {message && (
          <div
            className="font-sans"
            style={{ fontSize: 12.5, color: 'var(--color-ink-soft)', marginBottom: 18, lineHeight: 1.6 }}
          >{message}</div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="confirm-dialog-cancel"
            onClick={onCancel}
            className="font-sans"
            style={{ fontSize: 12, padding: '5px 12px', color: 'var(--color-ink-soft)' }}
          >{cancelLabel}</button>
          <button
            ref={confirmRef}
            type="button"
            data-testid="confirm-dialog-confirm"
            onClick={onConfirm}
            className="font-sans"
            style={{
              fontSize: 12, padding: '5px 14px', borderRadius: 3,
              background: 'var(--color-accent)', color: 'var(--color-paper)', fontWeight: 500,
            }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>,
    document.body);
}
