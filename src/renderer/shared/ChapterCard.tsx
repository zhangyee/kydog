type Props = {
  num: string;          // "I." / "II." / ...
  title: string;
  subtitle: string;
  tag?: string;
  onClick?: () => void;
  testId?: string;
};

export function ChapterCard({ num, title, subtitle, tag, onClick, testId }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      style={{
        textAlign: 'left',
        padding: '16px 18px', background: 'var(--color-paper)',
        border: '0.5px solid var(--color-ink-hair)',
        borderRadius: 3, cursor: 'pointer',
        boxShadow: '0 1px 0 rgba(70,55,40,0.04)',
        display: 'flex', gap: 14, alignItems: 'flex-start',
        position: 'relative', font: 'inherit',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-serif)', fontSize: 28, fontStyle: 'italic',
          color: 'var(--color-ink-faint)', lineHeight: 1, fontWeight: 400, minWidth: 34,
        }}
      >
        {num}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontFamily: 'var(--font-serif)', fontSize: 15, fontWeight: 600,
            color: 'var(--color-ink)', marginBottom: 4, lineHeight: 1.35,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontFamily: 'var(--font-serif)', fontSize: 12.5, lineHeight: 1.55,
            color: 'var(--color-ink-soft)', fontStyle: 'italic',
          }}
        >
          {subtitle}
        </div>
        {tag && (
          <div
            style={{
              marginTop: 10, display: 'inline-flex', alignItems: 'center',
              padding: '2px 7px', fontFamily: 'var(--font-mono)', fontSize: 10,
              color: 'var(--color-accent)',
              border: '0.5px solid var(--color-accent)',
              borderRadius: 2,
            }}
          >
            {tag}
          </div>
        )}
      </div>
    </button>
  );
}
