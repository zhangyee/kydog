import { forwardRef, type MouseEvent, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';

type Props = {
  size?: number;
  tooltip?: string;
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
  ariaLabel?: string;
  onClick?: (e: MouseEvent) => void;
  active?: boolean;
  disabled?: boolean;
  testId?: string;
  tone?: 'default' | 'faint' | 'ink';
  children: ReactNode;
};

export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { size = 24, tooltip, tooltipPlacement = 'bottom', ariaLabel, onClick, active, disabled, testId, tone = 'default', children },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type="button"
      data-testid={testId}
      disabled={disabled}
      aria-label={ariaLabel ?? tooltip}
      onClick={(e) => { if (!disabled) onClick?.(e); }}
      className="inline-flex items-center justify-center rounded-md transition-colors hover:bg-[color:var(--color-hover-bg)] disabled:opacity-50 disabled:cursor-default"
      style={{
        width: size,
        height: size,
        background: active ? 'var(--color-hover-bg)' : 'transparent',
        color: tone === 'ink' ? 'var(--color-ink)' : tone === 'faint' ? 'var(--color-ink-faint)' : 'var(--color-ink-soft)',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
  if (tooltip && !disabled) return <Tooltip content={tooltip} placement={tooltipPlacement}>{button}</Tooltip>;
  return button;
});
