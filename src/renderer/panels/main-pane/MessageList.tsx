import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';

export function MessageList({ threadId }: { threadId: string }) {
  const messages = useThreadsStore((s) => s.historyByThread[threadId] ?? []);
  const bufferByMessage = useRunsStore((s) => s.bufferByMessage);
  const liveBuffers = Object.entries(bufferByMessage).filter(([, v]) => v.threadId === threadId);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4" data-testid="message-list">
      {messages.map((m) =>
        m.role === 'user'
          ? <UserMessage key={m.id} name="Yee" content={m.content} />
          : <AssistantMessage key={m.id} threadId={threadId} messageId={m.id} blocks={m.blocks} />,
      )}
      {liveBuffers.map(([messageId, buf]) => (
        <AssistantMessage key={messageId} threadId={threadId} messageId={messageId} blocks={buf.blocks} live />
      ))}
    </div>
  );
}
