type Props = { text?: string };

export function StreamingIndicator({ text = '正在生成…' }: Props) {
  return (
    <div
      data-testid="streaming-indicator"
      className="ky-paper-deep flex items-center gap-2.5"
      style={{
        marginTop: 14, padding: '8px 12px',
        border: '0.5px solid var(--color-ink-hair)',
        borderRadius: 3, fontFamily: 'var(--font-mono)', fontSize: 11,
        color: 'var(--color-ink-soft)',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-amber)' }} />
      <span>{text}</span>
      <span
        style={{
          display: 'inline-block', width: 7, height: 14,
          background: 'var(--color-ink)', marginLeft: 2,
          animation: 'kydog-blink 1s steps(2, end) infinite',
        }}
      />
    </div>
  );
}
