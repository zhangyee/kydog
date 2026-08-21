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

/**
 * `settled`：这条消息**本轮已经结束**了吗。
 *
 * 由渲染点直接给，不在这里推断——`MessageList` 本来就分两支渲染：
 * `threadsStore.historyByThread` 里的是落定的消息，`runsStore.bufferByMessage`
 * 里的是本轮还在跑的那条。两支的边界就是协议事实：主进程在 pi 的 `agent_end`
 * 上发 `run.message_end`，`bootstrap.ts` 收到后 `takeBuffer` 把 blocks 搬进
 * history（见 `src/main/agent/AgentService.ts` 的 `agent_end` 分支）。
 *
 * 别改成读 `runState.status`：那是**线程**级的，历史消息会跟着新一轮重新变回
 * 「未落定」，而且换线程时判定也会串。
 */
type Props = {
  threadId: string;
  messageId: string;
  blocks: AssistantBlock[];
  settled: boolean;
  createdAt?: string;
};

export function AssistantMessage({ threadId, messageId, blocks, settled, createdAt }: Props) {
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  const projectPath = useThreadsStore((s) => {
    const t = Object.values(s.threadsByProject).flat().find((x) => x.id === threadId);
    return t?.projectPath ?? null;
  });
  const agentName = useIdentityStore((s) => s.agentName);
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);
  // 卡片延到本轮结束才出。
  //
  // 落盘那一刻就出卡片的话，用户点开的是半成品：learning-deck 的模板是 `cp` 之后
  // 逐章 `edit` 渲染的（spec F.2 的刻意取舍），HTML 文件出现时正文还在一章章往里填，
  // 交付前自检也还没跑。
  //
  // ⚠️ 判定用的是 `settled`（消息已落进 history），不是「最后一次写入之后多久没动静」
  //    之类的时间窗。skill 走到第几步、自检跑没跑，这些信号根本不存在于协议层；
  //    应用能拿到的确定事实只有「本轮结束」（`agent_end` → `run.message_end`）。
  const fileCards = useMemo(
    () => (settled ? collectFileCards(blocks, projectPath) : []),
    [settled, blocks, projectPath],
  );

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
