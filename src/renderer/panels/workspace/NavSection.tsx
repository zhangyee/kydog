import type { ReactNode } from 'react';

type Props = { title: string; children: ReactNode; right?: ReactNode };

export function NavSection({ title, children, right }: Props) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        className="flex items-center font-sans uppercase"
        style={{
          padding: '4px 12px', fontSize: 10, fontWeight: 600,
          color: 'var(--color-ink-faint)', letterSpacing: 1.2,
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
