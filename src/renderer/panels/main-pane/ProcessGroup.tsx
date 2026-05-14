import { useMemo, useState } from 'react';
import type { ProcessBlock } from './groupBlocks';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { useRunsStore } from '../../stores/runsStore';
import { processWallClock } from './processWallClock';

type Props = {
  threadId: string;
  messageId: string;
  blocks: ProcessBlock[];
};

function formatHeader(isRunning: boolean, wallMs: number | null): string {
  if (isRunning) return '处理中...';
  if (wallMs === null || wallMs <= 0) return '已处理';
  const secs = Math.max(1, Math.round(wallMs / 1000));
  return `已处理 ${secs}s`;
}

export function ProcessGroup({ threadId, messageId, blocks }: Props) {
  const isRunning = useRunsStore(
    (s) => s.runStateByThread[threadId]?.status === 'running' && !!s.bufferByMessage[messageId]
  );
  const wallMs = useMemo(() => processWallClock(blocks), [blocks]);
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? isRunning;
  const header = formatHeader(isRunning, wallMs);

  return (
    <div data-testid="process-group" style={{ margin: '8px 0 10px' }}>
      <button
        type="button"
        data-testid="process-toggle"
        onClick={() => setManual(!open)}
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
        >{header}</span>
        <span style={{ flex: 1 }} />
        <span className="font-mono" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
          {open ? '收起' : '展开'}
        </span>
      </button>
      {open && (
        <div data-testid="process-content" style={{ marginTop: 4 }}>
          {blocks.map((b, i) => {
            if (b.kind === 'thinking') return <ThinkingBlock key={`th-${i}`} block={b} />;
            return <ToolCard key={b.id} tool={b} />;
          })}
        </div>
      )}
    </div>
  );
}
