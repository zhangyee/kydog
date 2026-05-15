import { useMemo, useRef } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { APP_USER_NAME } from '../../shared';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ThreadHeader } from './ThreadHeader';
import { StreamingIndicator } from './StreamingIndicator';
import { useAutoScroll } from './useAutoScroll';

export function MessageList({ threadId }: { threadId: string }) {
  const messages = useThreadsStore((s) => s.historyByThread[threadId] ?? []);
  const bufferByMessage = useRunsStore((s) => s.bufferByMessage);
  const liveBuffers = Object.entries(bufferByMessage).filter(([, v]) => v.threadId === threadId);

  const userName = APP_USER_NAME.split(' ')[0];

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
      <div style={{ maxWidth: 840, margin: '0 auto', padding: '32px 48px 80px' }}>
        <ThreadHeader threadId={threadId} />
        {messages.map((m) =>
          m.role === 'user'
            ? <UserMessage key={m.id} name={userName} content={m.content} createdAt={m.createdAt} />
            : <AssistantMessage key={m.id} threadId={threadId} messageId={m.id} blocks={m.blocks} createdAt={m.createdAt} />,
        )}
        {liveBuffers.map(([messageId, buf]) => (
          <div key={messageId}>
            <AssistantMessage
              threadId={threadId}
              messageId={messageId}
              blocks={buf.blocks}
            />
            <StreamingIndicator />
          </div>
        ))}
      </div>
    </div>
  );
}
