import type { AssistantBlock } from '../../../shared/types';
import { MarkdownBlock } from './MarkdownBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { ErrorMarginalia } from './ErrorMarginalia';
import { useRunsStore } from '../../stores/runsStore';

type Props = { threadId: string; messageId: string; blocks: AssistantBlock[]; live?: boolean };

export function AssistantMessage({ threadId, blocks }: Props) {
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  return (
    <div className="my-4">
      {blocks.map((b, i) => {
        if (b.kind === 'text') return <MarkdownBlock key={i} content={b.text} />;
        if (b.kind === 'thinking') return <ThinkingBlock key={i} text={b.text} />;
        return <ToolCard key={b.id} tool={b} />;
      })}
      {runState?.status === 'error' && <ErrorMarginalia text={runState.error} />}
    </div>
  );
}
