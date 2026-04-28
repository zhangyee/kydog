import type { AssistantBlock } from '../../../shared/types';
import { MessageMeta } from '../../shared';
import { MarkdownBlock } from './MarkdownBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { ErrorMarginalia } from './ErrorMarginalia';
import { useRunsStore } from '../../stores/runsStore';

type Props = { threadId: string; messageId: string; blocks: AssistantBlock[]; createdAt?: string; live?: boolean };

function fmtTime(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function AssistantMessage({ threadId, blocks, createdAt }: Props) {
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  return (
    <div style={{ margin: '24px 0' }}>
      <MessageMeta side="agent" label="— KyDog" time={fmtTime(createdAt)} />
      <div
        className="font-serif"
        style={{ fontSize: 14.5, lineHeight: 1.75, color: 'var(--color-ink)' }}
      >
        {blocks.map((b, i) => {
          if (b.kind === 'text') return <MarkdownBlock key={i} content={b.text} />;
          if (b.kind === 'thinking') return <ThinkingBlock key={i} text={b.text} />;
          return <ToolCard key={b.id} tool={b} />;
        })}
        {runState?.status === 'error' && <ErrorMarginalia text={runState.error} />}
      </div>
    </div>
  );
}
