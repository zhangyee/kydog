import type { CSSProperties } from 'react';
import { NavIcon } from '../../shared';

const CHIP: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 260, padding: '3px 8px',
  borderRadius: 4, border: '0.5px solid var(--color-ink-hair)', background: 'var(--color-paper-edge)',
  fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--color-ink)',
};

function RemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button" data-testid="attachment-remove" aria-label={`移除 ${label}`}
      onClick={(e) => { e.stopPropagation(); onRemove(); }}
      className="opacity-0 group-hover:opacity-100"
      style={{ color: 'var(--color-ink-faint)', fontSize: 12, lineHeight: 1, padding: 0, background: 'transparent', border: 'none', cursor: 'pointer' }}
    >×</button>
  );
}

/** 附件托盘 / 输入框里的一张图片 chip（Task 9 复用）。 */
export function ImageChip({ src, name, onRemove, testId = 'tray-item' }: { src: string; name: string; onRemove?: () => void; testId?: string }) {
  return (
    <span className="group" data-testid={testId} data-name={name} title={name} style={CHIP}>
      <img data-testid="attachment-thumb" src={src} alt={name} style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 2, flexShrink: 0 }} />
      <span className="truncate">{name}</span>
      {onRemove ? <RemoveButton label={name} onRemove={onRemove} /> : null}
    </span>
  );
}

/** `hint` 是项目外文件的父目录：从左边截断，保留离文件最近的那几级（裁定 4）。 */
export function FileChip({ name, hint, title, onClick, onRemove, testId = 'tray-item' }: {
  name: string; hint?: string; title?: string; onClick?: () => void; onRemove?: () => void; testId?: string;
}) {
  return (
    <span
      className="group" data-testid={testId} data-name={name} title={title} onClick={onClick}
      style={{ ...CHIP, cursor: onClick ? 'pointer' : 'default' }}
    >
      <NavIcon name="file-text" size={12} />
      <span className="truncate">{name}</span>
      {hint ? (
        <span
          className="font-mono"
          style={{ direction: 'rtl', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: 'var(--color-ink-faint)' }}
        ><bdi>{hint}</bdi></span>
      ) : null}
      {onRemove ? <RemoveButton label={name} onRemove={onRemove} /> : null}
    </span>
  );
}
