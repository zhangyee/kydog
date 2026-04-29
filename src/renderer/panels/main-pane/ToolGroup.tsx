import { useState } from 'react';
import type { AssistantBlock } from '../../../shared/types';

type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;
type Props = { tools: ToolBlock[] };

const STATUS_COLOR = {
  running: 'var(--color-amber)',
  ok: 'var(--color-moss)',
  failed: 'var(--color-accent)',
} as const;

function deriveSource(cmd?: string): string {
  if (!cmd) return 'bash';
  const t = cmd.trim().split(/\s+/)[0];
  return t.length > 0 ? t : 'bash';
}

function tail(text: string, lines = 2): string {
  const arr = text.split('\n').filter(Boolean);
  return arr.slice(-lines).join(' · ');
}

export function ToolGroup({ tools }: Props) {
  const [open, setOpen] = useState(false);
  const n = tools.length;
  return (
    <div
      data-testid={`tool-group-${tools[0].id}`}
      className="ky-paper-deep"
      style={{ margin: '14px 0', border: '0.5px solid var(--color-ink-hair)', borderRadius: 3, overflow: 'hidden' }}
    >
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
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
          {n} 个并行工具调用
        </span>
        <span style={{ flex: 1 }} />
        <span className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
          {open ? '收起' : '展开'}
        </span>
      </button>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(n, 3)}, 1fr)`,
        }}
      >
        {tools.map((t, i) => {
          const text = t.chunks.map(c => c.data).join('');
          return (
            <div
              key={t.id}
              data-testid={`tool-${t.id}`}
              style={{
                padding: '10px 12px',
                borderRight: i < n - 1 && (i + 1) % 3 !== 0 ? '0.5px solid var(--color-ink-hair-soft)' : 'none',
                display: 'flex', flexDirection: 'column', gap: 6,
              }}
            >
              <div className="flex items-center gap-1.5">
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_COLOR[t.status] }} />
                <span className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-soft)', fontWeight: 500 }}>{deriveSource(t.command)}</span>
                <span style={{ flex: 1 }} />
                <span className="font-mono" style={{ fontSize: 9.5, color: 'var(--color-ink-faint)' }}>{t.status}</span>
              </div>
              <div
                className="font-mono truncate"
                style={{
                  fontSize: 10.5, color: 'var(--color-ink)',
                  background: 'var(--color-paper)', padding: '5px 7px',
                  borderRadius: 2, border: '0.5px solid var(--color-ink-hair-soft)',
                  lineHeight: 1.45,
                }}
                title={t.command}
              >
                {t.command ?? ''}
              </div>
              <div className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
                → {text ? tail(text) : '运行中…'}
              </div>
            </div>
          );
        })}
      </div>
      {open && (
        <div style={{ borderTop: '0.5px solid var(--color-ink-hair-soft)', padding: '8px 12px', background: 'var(--color-paper)' }}>
          {tools.map((t) => (
            <details key={t.id} style={{ marginBottom: 6 }}>
              <summary className="font-mono" style={{ fontSize: 10.5, color: 'var(--color-ink)' }}>
                $ {t.command}
              </summary>
              <pre
                className="font-mono"
                style={{
                  margin: '4px 0 0', padding: '8px 12px', background: '#1f1a15',
                  color: '#d9cfbf', borderRadius: 2, fontSize: 10.5,
                  whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
                }}
              >{t.chunks.map((c, i) => (
                <span key={i} data-stream={c.stream} style={{ color: c.stream === 'stderr' ? '#e0a48a' : '#d9cfbf' }}>
                  {c.data}
                </span>
              ))}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
