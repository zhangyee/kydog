import { useMemo } from 'react';
import type { AssistantBlock } from '../../../shared/types';
import { MessageMeta, fmtTime } from '../../shared';
import { MarkdownBlock } from './MarkdownBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { ToolGroup } from './ToolGroup';
import { ErrorMarginalia } from './ErrorMarginalia';
import { useRunsStore } from '../../stores/runsStore';

type Props = { threadId: string; messageId: string; blocks: AssistantBlock[]; createdAt?: string; live?: boolean };
type ToolBlock = Extract<AssistantBlock, { kind: 'tool_call' }>;

type Group =
  | { kind: 'text'; block: Extract<AssistantBlock, { kind: 'text' }> }
  | { kind: 'thinking'; block: Extract<AssistantBlock, { kind: 'thinking' }> }
  | { kind: 'tool'; tools: ToolBlock[] };

function groupBlocks(blocks: AssistantBlock[]): Group[] {
  const out: Group[] = [];
  let buf: ToolBlock[] = [];
  const flush = () => {
    if (buf.length) {
      out.push({ kind: 'tool', tools: buf });
      buf = [];
    }
  };
  for (const b of blocks) {
    if (b.kind === 'tool_call') {
      buf.push(b);
    } else if (b.kind === 'text') {
      flush();
      out.push({ kind: 'text', block: b });
    } else {
      flush();
      out.push({ kind: 'thinking', block: b });
    }
  }
  flush();
  return out;
}

export function AssistantMessage({ threadId, blocks, createdAt }: Props) {
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);

  return (
    <div style={{ margin: '24px 0' }}>
      <MessageMeta side="agent" label="— KyDog" time={fmtTime(createdAt)} />
      <div
        className="font-serif"
        style={{ fontSize: 14.5, lineHeight: 1.75, color: 'var(--color-ink)' }}
      >
        {groups.map((g, i) => {
          if (g.kind === 'tool') {
            return g.tools.length > 1
              ? <ToolGroup key={`g-${i}`} tools={g.tools} />
              : <ToolCard key={g.tools[0].id} tool={g.tools[0]} />;
          }
          if (g.kind === 'thinking') return <ThinkingBlock key={i} text={g.block.text} />;
          return <MarkdownBlock key={i} content={g.block.text} />;
        })}
        {runState?.status === 'error' && <ErrorMarginalia text={runState.error} />}
      </div>
    </div>
  );
}
