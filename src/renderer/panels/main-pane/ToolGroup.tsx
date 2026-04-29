import { useState } from 'react';
import type { AssistantBlock } from '../../../shared/types';
import { TOOL_STATUS_COLOR } from './toolStatus';
import { groupStatusSummary, groupToolLabel, groupToolLabelSummary, toolStatusLabel } from './toolSummary';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;
type Props = { tools: ToolBlock[] };

export function ToolGroup({ tools }: Props) {
  const [open, setOpen] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const n = tools.length;
  const labels = groupToolLabelSummary(tools);
  const summary = groupStatusSummary(tools);

  function toggleTool(id: string, hasOutput: boolean) {
    if (!hasOutput) return;
    setExpandedTools((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div
      data-testid={`tool-group-${tools[0].id}`}
      className="ky-paper-deep"
      style={{ margin: '14px 0', border: '0.5px solid var(--color-ink-hair)', borderRadius: 3, overflow: 'hidden' }}
    >
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        data-testid={`tool-group-toggle-${tools[0].id}`}
        className="w-full flex items-center gap-2 text-left"
        style={{
          padding: '7px 12px',
          background: 'var(--color-paper-edge)',
          borderBottom: '0.5px solid var(--color-ink-hair-soft)',
          fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--color-ink-soft)',
        }}
      >
        <span
          className="font-mono"
          style={{
            fontSize: 9, color: 'var(--color-accent)',
            padding: '1px 5px', border: '0.5px solid var(--color-accent)',
            borderRadius: 2, letterSpacing: 0.5,
          }}
        >PARALLEL · {n}</span>
        <span className="font-serif italic" style={{ color: 'var(--color-ink)' }}>
          {labels}
        </span>
        <span className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
          {summary}
        </span>
        <span style={{ flex: 1 }} />
        <span className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
          {open ? '收起' : '展开'}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', background: 'var(--color-paper)' }}>
          {tools.map((t, i) => {
            const hasOutput = t.chunks.length > 0;
            const rowOpen = !!expandedTools[t.id];
            const label = groupToolLabel(t);
            const status = toolStatusLabel(t.status);
            return (
              <div
                key={t.id}
                data-testid={`tool-${t.id}`}
                style={{ borderTop: i === 0 ? 'none' : '0.5px solid var(--color-ink-hair-soft)' }}
              >
                <button
                  type="button"
                  onClick={() => toggleTool(t.id, hasOutput)}
                  disabled={!hasOutput}
                  data-testid={`tool-toggle-${t.id}`}
                  className="w-full flex items-center gap-2 text-left disabled:cursor-default"
                  style={{
                    padding: '6px 10px',
                    fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--color-ink)',
                  }}
                  aria-expanded={rowOpen}
                >
                  <span className="w-3" style={{ color: 'var(--color-ink-faint)' }}>
                    {hasOutput ? (rowOpen ? '▾' : '▸') : ''}
                  </span>
                  <span
                    style={{ width: 6, height: 6, borderRadius: '50%', background: TOOL_STATUS_COLOR[t.status] }}
                  />
                  <span style={{ color: 'var(--color-ink-soft)', fontSize: 10 }}>{label}</span>
                  <span className="truncate flex-1" style={{ fontWeight: 500 }}>{status}</span>
                  <span className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
                    {hasOutput ? (rowOpen ? '收起' : '展开') : ''}
                  </span>
                </button>
                {rowOpen && hasOutput && (
                  <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', background: '#1f1a15' }}>
                    {t.command && (
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
                        $ {t.command}
                      </div>
                    )}
                    <pre
                      className="font-mono"
                      style={{
                        margin: 0, padding: '8px 12px', background: '#1f1a15',
                        color: '#d9cfbf', fontSize: 10.5, lineHeight: 1.55,
                        whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
                      }}
                    >
                      {t.chunks.map((c, idx) => (
                        <span key={idx} data-stream={c.stream} style={{ color: c.stream === 'stderr' ? '#e0a48a' : '#d9cfbf' }}>
                          {c.data}
                        </span>
                      ))}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
