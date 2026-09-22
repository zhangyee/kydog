import { useMemo, useRef } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { useIdentityStore } from '../../stores/identityStore';
import { useAskStore } from '../../stores/askStore';
import { useUiStore } from '../../stores/uiStore';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ThreadHeader } from './ThreadHeader';
import { StreamingIndicator } from './StreamingIndicator';
import { useAutoScroll } from './useAutoScroll';

export function MessageList({ threadId }: { threadId: string }) {
  const messages = useThreadsStore((s) => s.historyByThread[threadId] ?? []);
  const bufferByMessage = useRunsStore((s) => s.bufferByMessage);
  const liveBuffers = Object.entries(bufferByMessage).filter(([, v]) => v.threadId === threadId);
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

  const scrollRef = useRef<HTMLDivElement>(null);

  // tailSignal：thread 内所有 assistant text block 总数 + user message 总数
  // 新 text block 落地 → +1（override 跳底）；user message 发送 → +1（override 跳底）
  // 已有 text block 上追加 delta 不变（runsStore 就地拼接，不新建 block）
  const tailSignal = useMemo(() => {
    let n = 0;
    for (const m of messages) {
      if (m.role === 'user') n += 1;
      else for (const b of m.blocks) if (b.kind === 'text') n += 1;
    }
    for (const [, buf] of liveBuffers) {
      for (const b of buf.blocks) if (b.kind === 'text') n += 1;
    }
    return n;
  }, [messages, liveBuffers]);

  useAutoScroll(scrollRef, tailSignal, threadId);

  return (
    <div ref={scrollRef} className="ky-paper-grain ky-scroll flex-1 overflow-y-auto" data-testid="message-list">
      <div style={{ maxWidth: 840, margin: '0 auto', padding: narrow ? '32px 20px 80px' : '32px 48px 80px' }}>
        <ThreadHeader threadId={threadId} />
        {messages.map((m) =>
          m.role === 'user'
            ? <UserMessage key={m.id} name={userName} content={m.content} images={m.images} createdAt={m.createdAt} projectPath={projectPath} />
            // history 里的消息按定义已经落定：主进程在 pi 的 agent_end 上发
            // run.message_end，bootstrap 收到才把 buffer 搬进这里。
            : <AssistantMessage key={m.id} threadId={threadId} messageId={m.id} blocks={m.blocks} settled createdAt={m.createdAt} />,
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
            />
            {/* 提问态下卡片本身就是最强的状态提示，再挂个转圈只会打架。 */}
            {!askPending && <StreamingIndicator />}
          </div>
        ))}
      </div>
    </div>
  );
}
