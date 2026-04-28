import type { ReactNode } from 'react';
import { NavIcon, type NavIconName } from '../../shared';

type Props = {
  icon?: NavIconName | ReactNode;
  label: string;
  count?: number | string;
  selected?: boolean;
  muted?: boolean;
  dim?: boolean;
  onClick?: () => void;
  testId?: string;
};

export function NavPill({ icon, label, count, selected, muted, dim, onClick, testId }: Props) {
  const iconNode = typeof icon === 'string'
    ? <NavIcon name={icon as NavIconName} size={15} />
    : icon;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="flex items-center gap-2 px-2.5 py-1 rounded text-left w-full font-sans"
      style={{
        background: selected ? 'var(--color-paper-edge)' : 'transparent',
        color: dim ? 'var(--color-ink-faint)' : 'var(--color-ink)',
        fontSize: 13, fontWeight: selected ? 500 : 400,
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
