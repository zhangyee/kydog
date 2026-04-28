import { useState } from 'react';
import type { AssistantBlock } from '../../../shared/types';

type Props = { tool: Extract<AssistantBlock, { kind: 'tool_call' }> };

export function ToolCard({ tool }: Props) {
  const [open, setOpen] = useState(true);
  const status = tool.status;
  return (
    <div data-testid={`tool-${tool.id}`} className="my-2 border border-[color:var(--color-paper-edge)] rounded font-mono text-xs bg-[color:var(--color-paper-edge)]/30">
      <header className="flex items-center justify-between px-2 py-1">
        <span className="truncate">$ {tool.command ?? tool.name}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
          status === 'running' ? 'bg-yellow-200/50' :
          status === 'ok' ? 'bg-green-200/50' :
          'bg-red-200/50'
        }`}>
          {status}{tool.exitCode !== undefined ? ` · ${tool.exitCode}` : ''}
        </span>
      </header>
      {open && (
        <pre className="px-2 py-1 max-h-64 overflow-auto whitespace-pre-wrap">
          {tool.chunks.map((c, i) => (
            <span key={i} data-stream={c.stream} className={c.stream === 'stderr' ? 'text-[color:var(--color-accent)]' : ''}>{c.data}</span>
          ))}
        </pre>
      )}
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-[10px] px-2 py-0.5 text-[color:var(--color-ink-soft)]">
        {open ? '收起' : '展开'}
      </button>
    </div>
  );
}
