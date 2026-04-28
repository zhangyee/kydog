import type { CSSProperties } from 'react';

type Props = { title?: string };

export function TitleBar({ title = 'KyDog · 科研狗' }: Props) {
  return (
    <div
      data-testid="title-bar"
      className="h-9 w-full flex items-center justify-center select-none relative"
      style={{
        WebkitAppRegion: 'drag',
        background: 'linear-gradient(to bottom, var(--color-titlebar-bg-from), var(--color-titlebar-bg-to))',
        borderBottom: '0.5px solid var(--color-ink-hair)',
        paddingLeft: 80,
        paddingRight: 12,
      } as CSSProperties}
    >
      <div
        style={{
          fontFamily: 'var(--font-serif)', fontSize: 13, fontStyle: 'italic',
          color: 'var(--color-titlebar-text)', letterSpacing: 0.5,
          pointerEvents: 'none',
        }}
      >
        {title}
      </div>
    </div>
  );
}
