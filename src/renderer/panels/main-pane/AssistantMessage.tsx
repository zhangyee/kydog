import { useMemo } from 'react';
import type { AssistantBlock } from '../../../shared/types';
import { MessageMeta, fmtTime } from '../../shared';
import { MarkdownBlock } from './MarkdownBlock';
import { ProcessGroup } from './ProcessGroup';
import { QuestionRecapCard } from './QuestionRecapCard';
import { ErrorMarginalia } from './ErrorMarginalia';
import { FileCard } from './FileCard';
import { useRunsStore } from '../../stores/runsStore';
import { useThreadsStore } from '../../stores/threadsStore';
import { useIdentityStore } from '../../stores/identityStore';
import { groupBlocks } from './groupBlocks';
import { collectFileCards } from './fileCards';

type Props = { threadId: string; messageId: string; blocks: AssistantBlock[]; createdAt?: string };

export function AssistantMessage({ threadId, messageId, blocks, createdAt }: Props) {
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  const projectPath = useThreadsStore((s) => {
    const t = Object.values(s.threadsByProject).flat().find((x) => x.id === threadId);
    return t?.projectPath ?? null;
  });
  const agentName = useIdentityStore((s) => s.agentName);
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);
  const fileCards = useMemo(() => collectFileCards(blocks, projectPath), [blocks, projectPath]);

  return (
    <div style={{ margin: '24px 0' }}>
      <MessageMeta side="agent" label={agentName} time={fmtTime(createdAt)} />
      <div
        className="font-serif"
        style={{
          fontSize: 'var(--reading-font-size)',
          lineHeight: 'var(--reading-line-height)',
          color: 'var(--color-ink)',
        }}
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
          if (g.kind === 'ask') {
            return <QuestionRecapCard key={`ask-${g.block.toolCallId}`} block={g.block} />;
          }
          if (g.kind === 'text') {
            return <MarkdownBlock key={`tx-${i}`} content={g.block.text} />;
          }
          // 新增 Group 变体而忘了在这里处理时，这一行会编译不过。
          const exhaustive: never = g;
          return exhaustive;
        })}
        {fileCards.length > 0 && (
          <div data-testid="file-card-strip" style={{ marginTop: 10 }}>
            {fileCards.map((f) => (
              <FileCard key={f.path} path={f.path} projectPath={projectPath} size={f.size} />
            ))}
          </div>
        )}
        {runState?.status === 'error' && <ErrorMarginalia text={runState.error} />}
      </div>
    </div>
  );
}
