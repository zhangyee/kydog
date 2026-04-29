import { useEffect } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { MessageList } from './MessageList';
import { InputPill } from './InputPill';
import { NewThreadEmptyState } from './NewThreadEmptyState';
import { ThreadBreadcrumb } from './ThreadBreadcrumb';

export function ThreadView({ threadId }: { threadId: string }) {
  const messages = useThreadsStore((s) => s.historyByThread[threadId]);
  const initHistory = useThreadsStore((s) => s.initHistory);

  useEffect(() => {
    if (messages !== undefined) return;
    void window.kydog.invoke('thread.loadHistory', { threadId }).then((msgs) => {
      initHistory(threadId, msgs);
    });
  }, [threadId, messages, initHistory]);

  if (messages === undefined) {
    return <div className="p-6 text-sm" style={{ color: 'var(--color-ink-soft)' }}>加载中…</div>;
  }

  return (
    <div className="h-full flex flex-col">
      <ThreadBreadcrumb threadId={threadId} />
      <div className="flex-1 min-h-0 flex flex-col">
        {messages.length === 0 ? (
          <NewThreadEmptyState threadId={threadId} />
        ) : (
          <>
            <MessageList threadId={threadId} />
            <InputPill threadId={threadId} />
          </>
        )}
      </div>
    </div>
  );
}
