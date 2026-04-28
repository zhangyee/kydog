import type { AssistantBlock } from '../../../shared/types';
import { MarkdownBlock } from './MarkdownBlock';
import { ToolCard } from './ToolCard';
import { ErrorMarginalia } from './ErrorMarginalia';
import { useRunsStore } from '../../stores/runsStore';

type Props = { threadId: string; messageId: string; blocks: AssistantBlock[]; live?: boolean };

export function AssistantMessage({ threadId, blocks }: Props) {
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  return (
    <div className="my-4">
      {blocks.map((b, i) =>
        b.kind === 'text'
          ? <MarkdownBlock key={i} content={b.text} />
          : <ToolCard key={b.id} tool={b} />,
      )}
      {runState?.status === 'error' && <ErrorMarginalia text={runState.error} />}
    </div>
  );
}
