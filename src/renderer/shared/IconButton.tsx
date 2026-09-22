import { forwardRef, type MouseEvent, type ReactNode } from 'react';
import { Tooltip } from './Tooltip';

type Props = {
  size?: number;
  tooltip?: string;
  tooltipPlacement?: 'top' | 'bottom' | 'left' | 'right';
  ariaLabel?: string;
  onClick?: (e: MouseEvent) => void;
  active?: boolean;
  /**
   * `active` 态怎么画。`'subtle'`（默认，今天的老样子）：`var(--color-hover-bg)` 那种
   * 淡背景，颜色照 `tone` 走。`'accent'`：背景换 `var(--color-accent-soft)`、图标色换
   * `var(--color-accent)`（设计系统的强调色，不是红——CLAUDE.md 约定没有危险色 token），
   * 给「这东西现在是开着的」一个更显眼的信号。默认值让每个已有调用方（含 PDF 胶囊）
   * 不传就完全不变。
   */
  activeVariant?: 'subtle' | 'accent';
  disabled?: boolean;
  testId?: string;
  tone?: 'default' | 'faint' | 'ink';
  children: ReactNode;
};

// export：IconButton.test.tsx 要绕过 forwardRef 直接调内部渲染函数，得有个类型能标注它的 props
// （forwardRef 包出来的公开类型上没有 .render，运行时有——见该测试文件的说明）。
export type IconButtonProps = Props;

export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  {
    size = 24, tooltip, tooltipPlacement = 'bottom', ariaLabel, onClick, active, activeVariant = 'subtle',
    disabled, testId, tone = 'default', children,
  },
  ref,
) {
  const accentActive = active && activeVariant === 'accent';
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
        background: accentActive ? 'var(--color-accent-soft)' : active ? 'var(--color-hover-bg)' : 'transparent',
        color: accentActive
          ? 'var(--color-accent)'
          : tone === 'ink' ? 'var(--color-ink)' : tone === 'faint' ? 'var(--color-ink-faint)' : 'var(--color-ink-soft)',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {children}
    </button>
  );
  if (tooltip && !disabled) return <Tooltip content={tooltip} placement={tooltipPlacement}>{button}</Tooltip>;
  return button;
});
