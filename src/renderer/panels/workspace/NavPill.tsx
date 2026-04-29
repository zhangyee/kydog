import type { ReactNode } from 'react';
import { NavIcon, type NavIconName } from '../../shared';

type Props = {
  icon?: NavIconName | ReactNode;
  reserveIconSpace?: boolean;
  label: string;
  count?: number | string;
  shortcut?: string;
  selected?: boolean;
  muted?: boolean;
  dim?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  testId?: string;
};

export function NavPill({ icon, reserveIconSpace, label, count, shortcut, selected, muted, dim, disabled, onClick, testId }: Props) {
  const iconNode = typeof icon === 'string'
    ? <NavIcon name={icon as NavIconName} size={15} />
    : icon;
  const showLeadingSlot = Boolean(iconNode) || reserveIconSpace;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      title={disabled ? '即将开放' : undefined}
      className="group flex items-center gap-2 px-2.5 py-1 rounded-xl text-left w-full font-sans transition-colors hover:bg-[color:var(--color-hover-bg)]"
      style={{
        background: selected && !disabled ? 'var(--color-paper-edge)' : undefined,
        color: dim ? 'var(--color-ink-faint)' : 'var(--color-ink)',
        fontSize: 13, fontWeight: selected ? 500 : 400,
        opacity: disabled ? 0.5 : undefined,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {showLeadingSlot && (
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
      {count == null && shortcut && (
        <span
          className="shrink-0 rounded-full px-2 py-[3px] font-mono text-[11px] leading-none opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          style={{
            color: disabled ? 'var(--color-ink-soft)' : 'var(--color-ink)',
            background: 'var(--color-paper-edge)',
          }}
        >
          {shortcut}
        </span>
      )}
    </button>
  );
}
