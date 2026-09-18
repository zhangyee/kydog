import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';

type Props = { threadId: string };

export function ThreadBreadcrumb({ threadId }: Props) {
  const thread = useThreadsStore((s) =>
    Object.values(s.threadsByProject).flat().find((t) => t.id === threadId),
  );
  const messages = useThreadsStore((s) => s.historyByThread[threadId] ?? []);
  const runState = useRunsStore((s) => s.runStateByThread[threadId]);
  // 还在跑的这一轮不在历史里：它的块在 buffer 里，要等 run.message_end（agent_end 才发）
  // 才挪进 historyByThread。只数历史，计数就在整轮运行期间停着不动。
  // 挪的那一下是先 takeBuffer 再追加历史，同一条消息不会两边同时在。
  const inFlightTools = useRunsStore((s) =>
    Object.values(s.bufferByMessage).reduce(
      (acc, buf) => acc + (buf.threadId === threadId ? buf.blocks.filter((b) => b.kind === 'tool_call').length : 0),
      0,
    ),
  );

  if (!thread) return null;
  const projectName = thread.projectPath.split(/[\\/]/).pop() ?? thread.projectPath;
  // 一问一答算一回合：数用户发出的消息。用户那条一发出就进历史，助手那条要等本轮结束，
  // 数全部消息的话运行中是 1、结束一下跳成 2。
  const turns = messages.filter((m) => m.role === 'user').length;
  const tools = inFlightTools + messages.reduce(
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
