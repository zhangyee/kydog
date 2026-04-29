import { useState } from 'react';
import type { AssistantBlock } from '../../../shared/types';
import { TOOL_STATUS_COLOR } from './toolStatus';

type Props = { tool: Extract<AssistantBlock, { kind: 'tool_call' }> };

export function ToolCard({ tool }: Props) {
  const [open, setOpen] = useState(true);
  const hasOutput = tool.chunks.length > 0;
  const lines = tool.chunks.reduce((acc, c) => acc + (c.data.match(/\n/g)?.length ?? 0), 0);

  return (
    <div
      data-testid={`tool-${tool.id}`}
      className="ky-paper-deep"
      style={{
        margin: '12px 0', border: '0.5px solid var(--color-ink-hair)',
        borderRadius: 3, overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => hasOutput && setOpen(v => !v)}
        disabled={!hasOutput}
        className="w-full flex items-center gap-2 text-left disabled:cursor-default"
        style={{
          padding: '6px 10px',
          fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-ink)',
        }}
        aria-expanded={open}
      >
        <span className="w-3" style={{ color: 'var(--color-ink-faint)' }}>
          {hasOutput ? (open ? '▾' : '▸') : ''}
        </span>
        <span
          style={{ width: 6, height: 6, borderRadius: '50%', background: TOOL_STATUS_COLOR[tool.status] }}
        />
        <span style={{ color: 'var(--color-ink-soft)', fontSize: 10 }}>{tool.name}</span>
        <span className="truncate flex-1" style={{ fontWeight: 500 }}>$ {tool.command ?? ''}</span>
        {hasOutput && (
          <span style={{ color: 'var(--color-ink-faint)', fontSize: 10 }}>{lines} lines</span>
        )}
        {tool.exitCode !== undefined && (
          <span style={{ color: 'var(--color-ink-faint)', fontSize: 10 }}>exit {tool.exitCode}</span>
        )}
      </button>
      {open && hasOutput && (
        <pre
          className="font-mono"
          style={{
            margin: 0, padding: '8px 12px', background: '#1f1a15',
            borderTop: '0.5px solid var(--color-ink-hair-soft)',
            color: '#d9cfbf', fontSize: 10.5, lineHeight: 1.55,
            whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto',
          }}
        >
          {tool.chunks.map((c, i) => (
            <span key={i} data-stream={c.stream} style={{ color: c.stream === 'stderr' ? '#e0a48a' : '#d9cfbf' }}>
              {c.data}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
