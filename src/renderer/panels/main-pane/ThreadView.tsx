import { useEffect, useState } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { NewThreadEmptyState } from './NewThreadEmptyState';
import { ThreadBreadcrumb } from './ThreadBreadcrumb';
import { QuestionComposer } from './QuestionComposer';
import { useAskStore } from '../../stores/askStore';
import { ErrorMarginalia } from './ErrorMarginalia';

export function ThreadView({ threadId }: { threadId: string }) {
  const messages = useThreadsStore((s) => s.historyByThread[threadId]);
  const initHistory = useThreadsStore((s) => s.initHistory);
  const askPending = useAskStore((s) => s.pendingByThread[threadId]);
  // 窄模式判据与 Composer.tsx 一致：browserOpen（协议层事实），不是宽度阈值。
  // 面包屑整行收起，为对话栏腾出横向空间。
  const narrow = useUiStore((s) => s.browserOpen);
  // 失败连同 threadId 一起记：切走再切回来是另一条 thread 的事，不该继承上一条的错误。
  const [failure, setFailure] = useState<{ threadId: string; message: string } | null>(null);
  const error = failure?.threadId === threadId ? failure.message : null;

  useEffect(() => {
    // 失败后不自动重试：messages 仍是 undefined，不挡一下这个 effect 会被无限重跑。
    if (messages !== undefined || error !== null) return;
    let cancelled = false;
    void window.kydog.invoke('thread.loadHistory', { threadId })
      .then((msgs) => { if (!cancelled) initHistory(threadId, msgs); })
      .catch((err: unknown) => {
        // 这条以前只有 .then 没有 .catch：RPC 一失败就变成 unhandled rejection，
        // 界面永远停在「加载中…」，什么都不说。session 建不出来（模型配错、fixture
        // 坏了）时就是这个样子 —— 失败必须说出来，而不是装作还在加载。
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error('thread.loadHistory failed', err);
        setFailure({ threadId, message });
      });
    return () => { cancelled = true; };
  }, [threadId, messages, error, initHistory]);

  if (error !== null) {
    return (
      <div className="p-6 text-sm">
        <ErrorMarginalia text={`会话加载失败：${error}`} />
        <button
          type="button"
          data-testid="thread-load-retry"
          onClick={() => setFailure(null)}
          className="font-sans"
          style={{ marginTop: 10, fontSize: 12, color: 'var(--color-ink-soft)', textDecoration: 'underline' }}
        >
          重试
        </button>
      </div>
    );
  }

  if (messages === undefined) {
    return <div className="p-6 text-sm" style={{ color: 'var(--color-ink-soft)' }}>加载中…</div>;
  }

  return (
    <div className="h-full flex flex-col">
      {!narrow && <ThreadBreadcrumb threadId={threadId} />}
      <div className="flex-1 min-h-0 flex flex-col">
        {messages.length === 0 ? (
          <NewThreadEmptyState threadId={threadId} />
        ) : (
          <>
            <MessageList threadId={threadId} />
            {/* 整体替换而非叠加：模型 pill、发送按钮、slash 菜单一并消失，
                提问期间不存在第二条输入路径。 */}
            {askPending ? <QuestionComposer threadId={threadId} /> : <Composer threadId={threadId} />}
          </>
        )}
      </div>
    </div>
  );
}
