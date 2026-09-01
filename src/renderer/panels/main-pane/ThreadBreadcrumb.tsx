import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';

type Props = { threadId: string };

export function ThreadBreadcrumb({ threadId }: Props) {
  const thread = useThreadsStore((s) =>
    Object.values(s.threadsByProject).flat().find((t) => t.id === threadId),
  );
  const messages = useThreadsStore((s) => s.historyByThread[threadId] ?? []);
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);

  if (!thread) return null;
  const projectName = thread.projectPath.split(/[\\/]/).pop() ?? thread.projectPath;
  const turns = messages.length;
  const tools = messages.reduce(
    (acc, m) =>
      acc + (m.role === 'assistant' ? m.blocks.filter((b) => b.kind === 'tool_call').length : 0),
    0,
  );
  const isRunning = runState?.status === 'running';
  const isError = runState?.status === 'error';

  return (
    <div
      className="flex items-center shrink-0"
      style={{
        height: 30,
        padding: '0 22px',
        gap: 6,
        borderBottom: '0.5px solid var(--color-ink-hair-soft)',
        background: 'var(--color-paper)',
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        color: 'var(--color-ink-faint)',
      }}
    >
      <span className="font-mono text-[10px]">{projectName}</span>
      <span>›</span>
      <span
        className="font-serif italic"
        style={{ color: 'var(--color-ink)', fontSize: 12 }}
      >
        {thread.title}
      </span>
      <span style={{ flex: 1 }} />
      <span className="font-mono text-[10px]" data-testid="thread-stats">
        {turns} 回合 · {tools} 工具
      </span>
      {isRunning && (
        <span
          data-testid="run-status-running"
          className="font-mono text-[10px] flex items-center gap-1"
          style={{ color: 'var(--color-moss)' }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-moss)' }} />
          运行中
        </span>
      )}
      {isError && (
        <span
          data-testid="run-status-error"
          className="font-mono text-[10px] flex items-center gap-1"
          style={{ color: 'var(--color-accent)' }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-accent)' }} />
          错误
        </span>
      )}
    </div>
  );
}
