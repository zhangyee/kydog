import { useMemo } from 'react';
import type { AssistantBlock } from '../../../shared/types';
import { MessageMeta, fmtTime } from '../../shared';
import { MarkdownBlock } from './MarkdownBlock';
import { ProcessGroup } from './ProcessGroup';
import { ErrorMarginalia } from './ErrorMarginalia';
import { FileCard } from './FileCard';
import { useRunsStore } from '../../stores/runsStore';
import { useThreadsStore } from '../../stores/threadsStore';
import { groupBlocks } from './groupBlocks';
import { collectFileCards } from './fileCards';

type Props = { threadId: string; messageId: string; blocks: AssistantBlock[]; createdAt?: string };

export function AssistantMessage({ threadId, messageId, blocks, createdAt }: Props) {
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  const projectPath = useThreadsStore((s) => {
    const t = Object.values(s.threadsByProject).flat().find((x) => x.id === threadId);
    return t?.projectPath ?? null;
  });
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);
  const fileCards = useMemo(() => collectFileCards(blocks, projectPath), [blocks, projectPath]);

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
        {fileCards.length > 0 && (
          <div data-testid="file-card-strip" style={{ marginTop: 10 }}>
            {fileCards.map((p) => (
              <FileCard key={p} path={p} projectPath={projectPath} />
            ))}
          </div>
        )}
        {runState?.status === 'error' && <ErrorMarginalia text={runState.error} />}
      </div>
    </div>
  );
}
