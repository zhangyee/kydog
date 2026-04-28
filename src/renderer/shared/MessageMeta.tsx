type Props = { side: 'user' | 'agent'; label: string; time: string };

export function MessageMeta({ side, label, time }: Props) {
  const labelColor = side === 'user' ? 'var(--color-marginalia)' : 'var(--color-accent)';
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8,
        fontFamily: 'var(--font-sans)', fontSize: 10,
        color: 'var(--color-ink-faint)', letterSpacing: 0.8, textTransform: 'uppercase',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-serif)', fontSize: 11, fontStyle: 'italic',
          color: labelColor, fontWeight: 600, textTransform: 'none', letterSpacing: 0,
        }}
      >
        {label}
      </span>
      <span style={{ flex: 1, height: 0.5, background: 'var(--color-ink-hair-soft)' }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{time}</span>
    </div>
  );
}
