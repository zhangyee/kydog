import { useState } from 'react';
import type { AssistantBlock } from '../../../shared/types';

type ThinkingBlockData = Extract<AssistantBlock, { kind: 'thinking' }>;

function formatThinkingStatus(block: ThinkingBlockData): string {
  const label = block.status === 'running' ? '思考中' : '已思考';
  const secs = formatSeconds(block.durationMs);
  return secs ? `${label} · ${secs}` : label;
}

function formatSeconds(durationMs?: number): string | null {
  if (!durationMs || durationMs <= 0) return null;
  return `${Math.max(1, Math.round(durationMs / 1000))}s`;
}

export function ThinkingBlock({ block }: { block: ThinkingBlockData }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="thinking-block" style={{ margin: '8px 0 10px' }}>
      <button
        type="button"
        data-testid="thinking-toggle"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-left"
        style={{
          padding: 0,
          background: 'transparent',
          fontFamily: 'var(--font-sans)',
          fontSize: 10.5,
          color: 'var(--color-ink-faint)',
        }}
        aria-expanded={open}
      >
        <span
          className="font-serif italic"
          style={{ color: 'var(--color-ink-soft)', whiteSpace: 'nowrap' }}
        >{formatThinkingStatus(block)}</span>
        <span style={{ flex: 1 }} />
        <span className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
          {open ? '收起' : '展开'}
        </span>
      </button>
      {open && (
        <div
          data-testid="thinking-content"
          className="font-serif italic select-text"
          style={{
            marginTop: 4,
            paddingLeft: 14,
            color: 'var(--color-ink-soft)',
            fontSize: 13.5,
            lineHeight: 1.75,
            whiteSpace: 'pre-wrap',
          }}
        >
          {block.text}
        </div>
      )}
    </div>
  );
}
