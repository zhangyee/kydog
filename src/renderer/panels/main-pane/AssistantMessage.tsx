import { useMemo } from 'react';
import type { AssistantBlock } from '../../../shared/types';
import { MessageMeta, fmtTime } from '../../shared';
import { MarkdownBlock } from './MarkdownBlock';
import { ProcessGroup } from './ProcessGroup';
import { ErrorMarginalia } from './ErrorMarginalia';
import { useRunsStore } from '../../stores/runsStore';
import { groupBlocks } from './groupBlocks';

type Props = { threadId: string; messageId: string; blocks: AssistantBlock[]; createdAt?: string; live?: boolean };

export function AssistantMessage({ threadId, messageId, blocks, createdAt }: Props) {
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);

  return (
    <div style={{ margin: '24px 0' }}>
      <MessageMeta side="agent" label="KyDog" time={fmtTime(createdAt)} />
      <div
        className="font-serif"
        style={{ fontSize: 14.5, lineHeight: 1.75, color: 'var(--color-ink)' }}
      >
        {groups.map((g, i) => {
          if (g.kind === 'process') {
            return (
              <ProcessGroup
                key={`pg-${i}`}
                threadId={threadId}
                messageId={messageId}
                blocks={g.blocks}
              />
            );
          }
          return <MarkdownBlock key={`tx-${i}`} content={g.block.text} />;
        })}
        {runState?.status === 'error' && <ErrorMarginalia text={runState.error} />}
      </div>
    </div>
  );
}
