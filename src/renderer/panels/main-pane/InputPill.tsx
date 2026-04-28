import { useState } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';

export function InputPill({ threadId }: { threadId: string }) {
  const [value, setValue] = useState('');
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  const isRunning = runState?.status === 'running';
  const appendUser = useThreadsStore((s) => s.appendUserMessage);

  const onSend = async () => {
    if (!value.trim() || isRunning) return;
    const content = value;
    setValue('');
    appendUser(threadId, {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    });
    try {
      await window.kydog.invoke('thread.send', { threadId, content });
    } catch (err) {
      console.error('send failed', err);
    }
  };

  const onStop = async () => {
    await window.kydog.invoke('thread.abort', { threadId });
  };

  return (
    <div className="border-t border-[color:var(--color-paper-edge)] p-3 flex gap-2 items-end">
      <textarea
        data-testid="input-pill"
        disabled={isRunning}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void onSend(); } }}
        placeholder={isRunning ? '运行中…' : '输入消息（⌘/Ctrl+Enter 发送）'}
        rows={2}
        className="flex-1 resize-none border rounded px-2 py-1 bg-transparent font-sans text-sm disabled:opacity-50"
      />
      {isRunning ? (
        <button data-testid="stop-button" type="button" onClick={onStop}
          className="px-3 py-1 rounded bg-[color:var(--color-accent)] text-white text-sm">Stop</button>
      ) : (
        <button data-testid="send-button" type="button" onClick={onSend}
          className="px-3 py-1 rounded bg-[color:var(--color-accent)] text-white text-sm">发送</button>
      )}
    </div>
  );
}
