import type { ReactNode } from 'react';

type Props = { title: string; children: ReactNode; right?: ReactNode };

export function NavSection({ title, children, right }: Props) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        className="flex items-center font-sans"
        style={{
          padding: '4px 12px', fontSize: 13, fontWeight: 500,
          color: 'var(--color-ink-soft)',
        }}
      >
        <span className="flex-1">{title}</span>
        {right}
      </div>
      <div className="flex flex-col gap-px" style={{ padding: '2px 6px' }}>
        {children}
      </div>
    </div>
  );
}
