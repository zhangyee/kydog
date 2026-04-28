export function Citation({ n }: { n: number | string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-serif)', fontSize: 11, verticalAlign: 'super',
        color: 'var(--color-accent)', fontWeight: 600, padding: '0 1px', cursor: 'pointer',
      }}
    >
      [{n}]
    </span>
  );
}
