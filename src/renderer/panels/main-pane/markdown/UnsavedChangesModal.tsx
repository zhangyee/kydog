type Props = {
  fileTitle: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
};

export function UnsavedChangesModal({ fileTitle, onSave, onDiscard, onCancel }: Props) {
  return (
    <div
      data-testid="unsaved-modal"
      className="absolute inset-0 z-50 flex items-center justify-center"
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
          style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 6 }}
        >未保存的修改</div>
        <div
          className="font-sans"
          style={{ fontSize: 12.5, color: 'var(--color-ink-soft)', marginBottom: 18, lineHeight: 1.6 }}
        >
          《{fileTitle}》有未保存的修改。关闭前是否保存？
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="unsaved-cancel"
            onClick={onCancel}
            className="font-sans"
            style={{ fontSize: 12, padding: '5px 12px', color: 'var(--color-ink-soft)' }}
          >取消</button>
          <button
            type="button"
            data-testid="unsaved-discard"
            onClick={onDiscard}
            className="font-sans"
            style={{ fontSize: 12, padding: '5px 12px', color: 'var(--color-ink-soft)' }}
          >不保存</button>
          <button
            type="button"
            data-testid="unsaved-save"
            onClick={onSave}
            className="font-sans"
            style={{
              fontSize: 12, padding: '5px 14px', borderRadius: 3,
              background: 'var(--color-accent)', color: 'var(--color-paper)', fontWeight: 500,
            }}
          >保存</button>
        </div>
      </div>
    </div>
  );
}
