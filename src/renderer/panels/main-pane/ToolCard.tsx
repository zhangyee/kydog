import { useState } from 'react';
import type { AssistantBlock } from '../../../shared/types';

type Props = { tool: Extract<AssistantBlock, { kind: 'tool_call' }> };

export function ToolCard({ tool }: Props) {
  const [open, setOpen] = useState(true);
  const status = tool.status;
  const hasOutput = tool.chunks.length > 0;
  return (
    <div
      data-testid={`tool-${tool.id}`}
      className="my-3 border border-[color:var(--color-paper-edge)] rounded overflow-hidden bg-[color:var(--color-paper-edge)]/20 font-mono text-xs"
    >
      <button
        type="button"
        onClick={() => hasOutput && setOpen(v => !v)}
        disabled={!hasOutput}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left disabled:cursor-default enabled:hover:bg-[color:var(--color-paper-edge)]/40"
      >
        <span className="text-[color:var(--color-ink-soft)] w-3 select-none">
          {hasOutput ? (open ? '▾' : '▸') : ''}
        </span>
        <span className="text-[color:var(--color-marginalia)] uppercase tracking-wider text-[10px] shrink-0">{tool.name}</span>
        <span className="truncate text-[color:var(--color-ink)] flex-1">$ {tool.command ?? ''}</span>
        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${
          status === 'running' ? 'bg-yellow-200/40 text-yellow-900' :
          status === 'ok' ? 'bg-green-200/40 text-green-900' :
          'bg-red-200/40 text-red-900'
        }`}>
          {status}{tool.exitCode !== undefined ? ` · ${tool.exitCode}` : ''}
        </span>
      </button>
      {open && hasOutput && (
        <pre className="px-3 py-2 max-h-64 overflow-auto whitespace-pre-wrap border-t border-[color:var(--color-paper-edge)] bg-[color:var(--color-paper)]/40">
          {tool.chunks.map((c, i) => (
            <span key={i} data-stream={c.stream} className={c.stream === 'stderr' ? 'text-[color:var(--color-accent)]' : ''}>{c.data}</span>
          ))}
        </pre>
      )}
    </div>
  );
}
