import { useMemo, type RefObject } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { useIdentityStore } from '../../stores/identityStore';
import { useAskStore } from '../../stores/askStore';
import { useUiStore } from '../../stores/uiStore';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ThreadHeader } from './ThreadHeader';
import { StreamingIndicator } from './StreamingIndicator';
import { latestResearchTaskMessages } from './researchTaskAnchor';
import { latestXResearchTaskMessages, type XResearchTaskAnchor } from './xResearchTaskAnchor';
import { useXResearchTaskStore, xResearchTaskGroupKey } from '../../stores/xResearchTaskStore';

const EMPTY_RESEARCH_RUN_IDS: ReadonlySet<string> = new Set();
const EMPTY_X_RESEARCH_ANCHORS: readonly XResearchTaskAnchor[] = [];

/**
 * @param scrollRef 滚动容器。**由 `ThreadView` 拿着**：跟随状态要同时喂给它上方的
 *   「跳到最新」按钮，而那颗按钮浮在输入框上，不在这棵树里。
 */
export function MessageList({ threadId, scrollRef }: { threadId: string; scrollRef: RefObject<HTMLDivElement | null> }) {
  const messages = useThreadsStore((s) => s.historyByThread[threadId] ?? []);
  const bufferByMessage = useRunsStore((s) => s.bufferByMessage);
  const liveBuffers = Object.entries(bufferByMessage).filter(([, v]) => v.threadId === threadId);
  // 两份锚点看同一串消息：web research 每个 run 一张卡，x research **一个回合一张卡**；
  // 两者都跟着「最后一次提到它的那条消息」走。x 的分组键要查快照（`runId`），所以订阅池子：
  // 一段研究的广播到了，同一回合的几段才会并到同一张卡上。
  const anchorMessages = useMemo(() => [
    ...messages.flatMap((message) => message.role === 'assistant'
      ? [{ messageId: message.id, blocks: message.blocks }]
      : []),
    ...Object.entries(bufferByMessage).flatMap(([messageId, buffer]) => buffer.threadId === threadId
      ? [{ messageId, blocks: buffer.blocks }]
      : []),
  ], [messages, bufferByMessage, threadId]);
  const researchTaskRunsByMessage = useMemo(() => latestResearchTaskMessages(anchorMessages), [anchorMessages]);
  const xResearchSnapshots = useXResearchTaskStore((s) => s.snapshotsByRunId);
  // 快照还没到的研究退回自己那一格（旧数据、刚提交的那一瞬）：卡片不会因此空白。
  const xResearchGroupKeyOf = useMemo(
    () => (researchRunId: string) => {
      const snapshot = xResearchSnapshots[researchRunId];
      return snapshot ? xResearchTaskGroupKey(snapshot) : researchRunId;
    },
    [xResearchSnapshots],
  );
  const xResearchAnchorsByMessage = useMemo(
    () => latestXResearchTaskMessages(anchorMessages, xResearchGroupKeyOf),
    [anchorMessages, xResearchGroupKeyOf],
  );
  const askPending = useAskStore((s) => s.pendingByThread[threadId]);
  // 窄模式判据与 Composer.tsx 一致：browserOpen（协议层事实），不是宽度阈值。
  // 正文左右边距跟着收窄，给对话栏腾出来的横向空间不被留白吃掉。
  const narrow = useUiStore((s) => s.browserOpen);

  const userName = useIdentityStore((s) => s.userName);
  // 历史里的用户消息按发出去时所在的对话找项目路径，用来把附件/引用里的
  // 相对路径解析成绝对路径去开（UserMessage 里 openerFor）。
  const projectPath = useThreadsStore((s) =>
    Object.values(s.threadsByProject).flat().find((t) => t.id === threadId)?.projectPath ?? null,
  );

  return (
    // 贴底 / 自由阅读由 useAutoScroll 自己管理。Chromium 的原生 scroll anchoring 会在上方卡片
    // 收起、下方内容增长时自行改写 scrollTop；普通 scroll 事件又不带来源，状态机会把它误认成
    // 用户翻走。这里从源头关掉那套互相冲突的锚定语义，真实滚轮/键盘/滚动条仍照常发 scroll。
    <div ref={scrollRef} className="ky-paper-grain ky-scroll flex-1 overflow-y-auto"
      style={{ overflowAnchor: 'none' }} data-testid="message-list">
      <div style={{ maxWidth: 840, margin: '0 auto', padding: narrow ? '32px 20px 80px' : '32px 48px 80px' }}>
        <ThreadHeader threadId={threadId} />
        {messages.map((m) =>
          m.role === 'user'
            ? <UserMessage key={m.id} name={userName} content={m.content} images={m.images} createdAt={m.createdAt} projectPath={projectPath} />
            // history 里的消息按定义已经落定：主进程在 pi 的 agent_end 上发
            // run.message_end，bootstrap 收到才把 buffer 搬进这里。
            : <AssistantMessage key={m.id} threadId={threadId} messageId={m.id} blocks={m.blocks}
              settled createdAt={m.createdAt}
              researchTaskRunIds={researchTaskRunsByMessage.get(m.id) ?? EMPTY_RESEARCH_RUN_IDS}
              xResearchAnchors={xResearchAnchorsByMessage.get(m.id) ?? EMPTY_X_RESEARCH_ANCHORS} />,
        )}
        {liveBuffers.map(([messageId, buf]) => (
          <div key={messageId}>
            {/* 还在 buffer 里 = 本轮没结束。settled=false 让文件卡片先不出现
                （理由见 AssistantMessage 里 fileCards 那段注释）。 */}
            <AssistantMessage
              threadId={threadId}
              messageId={messageId}
              blocks={buf.blocks}
              settled={false}
              researchTaskRunIds={researchTaskRunsByMessage.get(messageId) ?? EMPTY_RESEARCH_RUN_IDS}
              xResearchAnchors={xResearchAnchorsByMessage.get(messageId) ?? EMPTY_X_RESEARCH_ANCHORS}
            />
            {/* 提问态下卡片本身就是最强的状态提示，再挂个转圈只会打架。 */}
            {!askPending && <StreamingIndicator />}
          </div>
        ))}
      </div>
    </div>
  );
}
