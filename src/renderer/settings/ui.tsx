import type { CSSProperties, ReactNode } from 'react';

export const inputStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  borderBottom: '0.5px solid var(--color-ink-hair-soft)',
  padding: '7px 0',
  fontFamily: 'var(--font-mono)', fontSize: 11.5,
  color: 'var(--color-ink)',
  width: '100%',
};

export const labelStyle: CSSProperties = { fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--color-ink)', fontWeight: 500 };
export const hintStyle: CSSProperties = { fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: 11, color: 'var(--color-ink-faint)', marginTop: 4, lineHeight: 1.55 };

export function Card({ children }: { children: ReactNode }) {
  return (
    <div style={{
      border: '0.5px solid var(--color-ink-hair)',
      borderRadius: 6,
      padding: '16px 18px',
      background: 'var(--color-paper)',
    }}>{children}</div>
  );
}

export function BlockHeader({ children }: { children: ReactNode }) {
  return (
    <div className="font-serif" style={{ fontSize: 18, color: 'var(--color-ink)', marginBottom: 10 }}>
      {children}
    </div>
  );
}

export function SubHeader({ title, subtitle }: { title?: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      {title && (
        <div className="font-mono uppercase" style={{ fontSize: 10, letterSpacing: 1.5, color: 'var(--color-ink-faint)' }}>
          {title}
        </div>
      )}
      {subtitle && (
        <div className="font-serif italic" style={{ fontSize: 12, color: 'var(--color-ink-soft)', marginTop: title ? 4 : 0 }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

export function Divider() {
  return <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', margin: '16px 0' }} />;
}

export type BtnVariant = 'primary' | 'secondary' | 'danger';

export function Btn({
  variant = 'primary',
  onClick,
  disabled,
  children,
  title,
  testId,
}: {
  variant?: BtnVariant;
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
  title?: string;
  testId?: string;
}) {
  // Base layout (font, padding, radius) stays inline; colors/borders + hover live in className
  // so :hover (which inline styles cannot express) works via Tailwind arbitrary-value classes.
  const base: CSSProperties = {
    fontFamily: 'var(--font-mono, ui-monospace)',
    fontSize: 11,
    padding: '4px 10px',
    borderRadius: 6,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background-color 120ms, color 120ms, border-color 120ms',
  };
  const hoverClass = disabled
    ? ''
    : variant === 'primary'
      ? 'hover:bg-[color:var(--color-hover-bg)]'
      : variant === 'secondary'
        ? 'hover:bg-[color:var(--color-hover-bg)] hover:text-[color:var(--color-ink)] hover:border-[color:var(--color-ink-hair-soft)]'
        : 'hover:bg-[color:var(--color-danger-soft,rgba(192,57,43,0.08))]';
  const variantStyle: Record<BtnVariant, CSSProperties> = {
    primary: {
      background: 'var(--color-paper-edge)',
      color: 'var(--color-ink)',
      border: '0.5px solid var(--color-ink-hair)',
    },
    secondary: {
      background: 'transparent',
      color: 'var(--color-ink-soft)',
      border: '0.5px solid transparent',
    },
    danger: {
      background: 'transparent',
      color: 'var(--color-danger, #c0392b)',
      border: '0.5px solid transparent',
    },
  };
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={title}
      className={hoverClass}
      style={{ ...base, ...variantStyle[variant] }}
    >
      {children}
    </button>
  );
}

export function Empty() {
  return <div style={{ color: 'var(--color-ink-faint)', fontSize: 12, padding: '4px 0' }}>（无）</div>;
}
