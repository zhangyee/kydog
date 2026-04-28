import type { CSSProperties } from 'react';

export function Hairline({ vertical = false, soft = false, style }: { vertical?: boolean; soft?: boolean; style?: CSSProperties }) {
  const c = soft ? 'var(--color-ink-hair-soft)' : 'var(--color-ink-hair)';
  return (
    <div
      style={{
        background: c,
        ...(vertical ? { width: 0.5, alignSelf: 'stretch' } : { height: 0.5, width: '100%' }),
        ...(style ?? {}),
      }}
    />
  );
}
