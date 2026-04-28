type Props = { side: 'left' | 'right'; filled?: boolean; size?: number };

export function PanelIcon({ side, filled = false, size = 14 }: Props) {
  const stroke = 'currentColor';
  const barW = 4;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" style={{ display: 'block' }}>
      <rect x="1" y="2.5" width="12" height="9" rx="1.5" stroke={stroke} strokeWidth="1" />
      {side === 'left' && (
        <rect x="1.5" y="3" width={barW} height="8" fill={stroke} opacity={filled ? 0.85 : 0.3} />
      )}
      {side === 'right' && (
        <rect x={14 - 1.5 - barW} y="3" width={barW} height="8" fill={stroke} opacity={filled ? 0.85 : 0.3} />
      )}
    </svg>
  );
}
