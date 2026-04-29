import type { CSSProperties } from 'react';
import { PanelIcon } from '../shared';

type Props = { side: 'left' | 'right'; label: string; onOpen: () => void; testId?: string };

export function CollapsedRail({ side, label, onOpen, testId }: Props) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onOpen}
      title={side === 'left' ? '展开左栏' : '展开右栏'}
      aria-label={`展开 ${label}`}
      className="ky-paper-deep h-full w-full flex flex-col items-center cursor-pointer hover:[--rail-bg:var(--color-hover-bg)]"
      style={{
        gap: 14, padding: '12px 0',
        color: 'var(--color-ink-faint)',
        background: 'var(--rail-bg, var(--color-paper-deep))',
      } as CSSProperties}
    >
      <PanelIcon side={side} filled={false} size={13} />
      <div className="flex-1 w-px" style={{ background: 'var(--color-ink-hair)' }} />
      <div
        className="font-mono uppercase"
        style={{
          writingMode: 'vertical-rl',
          transform: side === 'left' ? 'rotate(180deg)' : 'none',
          fontSize: 9.5, letterSpacing: 1.5, padding: '4px 0',
        }}
      >
        {label}
      </div>
    </button>
  );
}
