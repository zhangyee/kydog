import type { ReactNode } from 'react';
import { NavIcon, type NavIconName } from '../../shared';

type Props = {
  icon?: NavIconName | ReactNode;
  label: string;
  count?: number | string;
  selected?: boolean;
  muted?: boolean;
  dim?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
};

export function NavPill({ icon, label, count, selected, muted, dim, disabled, onClick, testId }: Props) {
  const iconNode = typeof icon === 'string'
    ? <NavIcon name={icon as NavIconName} size={15} />
    : icon;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={disabled ? '即将开放' : undefined}
      className="flex items-center gap-2 px-2.5 py-1 rounded text-left w-full font-sans"
      style={{
        background: selected && !disabled ? 'var(--color-paper-edge)' : 'transparent',
        color: dim ? 'var(--color-ink-faint)' : 'var(--color-ink)',
        fontSize: 13, fontWeight: selected ? 500 : 400,
        opacity: disabled ? 0.5 : undefined,
        cursor: disabled ? 'default' : undefined,
      }}
    >
      {iconNode && (
        <span
          className="w-4 h-4 inline-flex items-center justify-center shrink-0"
          style={{ color: muted ? 'var(--color-ink-faint)' : (selected ? 'var(--color-ink)' : 'var(--color-ink-soft)') }}
        >
          {iconNode}
        </span>
      )}
      <span className="flex-1 truncate">{label}</span>
      {count != null && (
        <span className="font-mono text-[10px]" style={{ color: 'var(--color-ink-faint)' }}>{count}</span>
      )}
    </button>
  );
}
