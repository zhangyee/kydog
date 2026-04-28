import { useEffect, useState } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { MessageList } from './MessageList';
import { InputPill } from './InputPill';
import { NewThreadEmptyState } from './NewThreadEmptyState';

export function ThreadView({ threadId }: { threadId: string }) {
  const messages = useThreadsStore((s) => s.historyByThread[threadId]);
  const setHistory = useThreadsStore((s) => s.setHistory);
  const [prefill, setPrefill] = useState<string>('');

  useEffect(() => {
    if (messages !== undefined) return;
    void window.kydog.invoke('thread.loadHistory', { threadId }).then((msgs) => {
      setHistory(threadId, msgs);
    });
  }, [threadId, messages, setHistory]);

  if (messages === undefined) return <div className="p-6 text-sm text-[color:var(--color-ink-soft)]">加载中…</div>;

  return (
    <div className="h-full flex flex-col">
      {messages.length === 0
        ? <NewThreadEmptyState onPickCard={setPrefill} />
        : <MessageList threadId={threadId} />}
      <InputPill threadId={threadId} key={prefill /* simplistic prefill: remount on pick */} />
    </div>
  );
}
