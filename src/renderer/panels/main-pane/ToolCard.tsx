import { useState } from 'react';
import type { AssistantBlock } from '../../../shared/types';
import { TOOL_STATUS_COLOR } from './toolStatus';
import { toolLabel, toolStatusLabel } from './toolSummary';

type Props = { tool: Extract<AssistantBlock, { kind: 'tool_call' }> };

export function ToolCard({ tool }: Props) {
  const [open, setOpen] = useState(false);
  const hasOutput = tool.chunks.length > 0;
  const label = toolLabel(tool);
  const status = toolStatusLabel(tool.status);

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
        data-testid={`tool-toggle-${tool.id}`}
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
        <span style={{ color: 'var(--color-ink-soft)', fontSize: 10 }}>{label}</span>
        <span className="truncate flex-1" style={{ fontWeight: 500 }}>{status}</span>
        <span className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
          {hasOutput ? (open ? '收起' : '展开') : ''}
        </span>
      </button>
      {open && hasOutput && (
        <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', background: '#1f1a15' }}>
          {tool.command && (
            <div
              className="font-mono"
              style={{
                padding: '8px 12px 6px',
                color: '#d9cfbf',
                fontSize: 10.5,
                lineHeight: 1.45,
                borderBottom: '0.5px solid rgba(217, 207, 191, 0.12)',
                whiteSpace: 'pre-wrap',
              }}
            >
              $ {tool.command}
            </div>
          )}
          <pre
            className="font-mono"
            style={{
              margin: 0, padding: '8px 12px', background: '#1f1a15',
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
        </div>
      )}
    </div>
  );
}
