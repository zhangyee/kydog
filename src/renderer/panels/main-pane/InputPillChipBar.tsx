import type { ReactNode } from 'react';

type Props = {
  large: boolean;
  left?: ReactNode;
  right: ReactNode;
};

export function InputPillChipBar({ large, left, right }: Props) {
  return (
    <div
      className="flex items-center gap-2"
      style={{
        marginTop: large ? 10 : 8,
        paddingTop: large ? 10 : 8,
        borderTop: '0.5px solid var(--color-ink-hair-soft)',
      }}
    >
      {left}
      <span style={{ flex: 1 }} />
      {right}
    </div>
  );
}
