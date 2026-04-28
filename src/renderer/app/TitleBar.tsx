import type { CSSProperties } from 'react';

export function TitleBar() {
  return (
    <div
      className="h-9 w-full flex items-center justify-center text-xs font-mono text-[color:var(--color-ink-soft)]"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    >
      KyDog
    </div>
  );
}
