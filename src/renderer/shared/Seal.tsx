type Props = { size?: number; text?: string; rotate?: number };

export function Seal({ size = 44, text = '研', rotate = -4 }: Props) {
  return (
    <div
      style={{
        width: size, height: size,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--color-accent)', color: 'var(--color-paper)',
        fontFamily: 'var(--font-serif)', fontWeight: 700, fontSize: size * 0.55,
        transform: `rotate(${rotate}deg)`,
        boxShadow: 'inset 0 0 0 1.5px var(--color-paper), inset 0 0 0 2px var(--color-accent)',
        borderRadius: 3, filter: 'contrast(1.05)', userSelect: 'none',
      }}
    >
      {text}
    </div>
  );
}
