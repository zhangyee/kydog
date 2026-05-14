import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { APP_USER_NAME } from '../../shared';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { ThreadHeader } from './ThreadHeader';
import { StreamingIndicator } from './StreamingIndicator';

export function MessageList({ threadId }: { threadId: string }) {
  const messages = useThreadsStore((s) => s.historyByThread[threadId] ?? []);
  const bufferByMessage = useRunsStore((s) => s.bufferByMessage);
  const liveBuffers = Object.entries(bufferByMessage).filter(([, v]) => v.threadId === threadId);

  const userName = APP_USER_NAME.split(' ')[0];

  return (
    <div className="ky-paper-grain ky-scroll flex-1 overflow-y-auto" data-testid="message-list">
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
