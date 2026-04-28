import type { ReactNode } from 'react';
import { Children } from 'react';

export function TreeChildren({ children }: { children: ReactNode }) {
  const arr = Children.toArray(children);
  return (
    <div style={{ paddingLeft: 10, position: 'relative' }}>
      <div
        style={{
          position: 'absolute', left: 14, top: 2, bottom: 2,
          width: 1, background: 'var(--color-ink-hair)',
        }}
      />
      {arr.map((child, i) => (
        <div key={i} style={{ paddingLeft: 12 }}>{child}</div>
      ))}
    </div>
  );
}
