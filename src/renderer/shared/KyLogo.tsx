import type { CSSProperties } from 'react';

type Props = {
  size?: number;
  peerSize?: boolean;   // shows "KyDog" alongside "科研狗" at the same size (hero variant)
  tight?: boolean;
  color?: string;
  style?: CSSProperties;
};

export function KyLogo({ size = 20, peerSize = false, tight = false, color, style }: Props) {
  const ink = color ?? 'var(--color-ink)';
  if (peerSize) {
    return (
      <div
        style={{
          display: 'inline-flex', alignItems: 'baseline', gap: size * 0.35,
          fontFamily: 'var(--font-serif)', fontSize: size, lineHeight: 1, color: ink,
          fontWeight: 500, letterSpacing: -size * 0.02, ...(style ?? {}),
        }}
      >
        <span>
          <span style={{ fontWeight: 700 }}>Ky</span>
          <span style={{ fontWeight: 400, fontStyle: 'italic' }}>Dog</span>
        </span>
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: size, fontWeight: 500, color: ink }}>科研狗</span>
      </div>
    );
  }
  return (
    <div
      style={{
        display: 'inline-flex', alignItems: 'baseline', gap: tight ? 1 : 2,
        fontFamily: 'var(--font-serif)', fontSize: size, lineHeight: 1, color: ink,
        fontWeight: 500, fontStyle: 'italic', letterSpacing: -size * 0.02, ...(style ?? {}),
      }}
    >
      <span style={{ fontWeight: 700, fontStyle: 'normal' }}>Ky</span>
      <span style={{ fontWeight: 400, fontStyle: 'italic' }}>Dog</span>
    </div>
  );
}
