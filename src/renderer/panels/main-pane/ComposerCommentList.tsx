import { useComposerDraftStore, EMPTY_DRAFT } from './composerDraftStore';
import { confirm } from '../../stores/confirmStore';
import { CommentCard } from './CommentCard';
import { toMessagePath } from './attachments';

/** 输入框里待发的批注（2A ②）：附件托盘之下、正文之上；限高、区内滚动（spec §2.4）。 */
export function ComposerCommentList({ threadId, projectPath }: { threadId: string; projectPath: string | null }) {
  const comments = (useComposerDraftStore((s) => s.byThread[threadId]) ?? EMPTY_DRAFT).comments;
  if (comments.length === 0) return null;
  const S = useComposerDraftStore.getState;
  const onClearAll = async () => {
    const ok = await confirm({ title: `清除 ${comments.length} 条待发送的批注？`, message: '写好的批注会丢掉，原文件不受影响。', confirmLabel: '清除' });
    if (ok) S().clearComments(threadId);
  };
  return (
    <div data-testid="composer-comments" style={{ marginBottom: 8 }}>
      <div className="flex items-center" style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--color-ink-soft)', marginBottom: 4 }}>
        <span data-testid="composer-comments-count">{`待发送的批注 · ${comments.length}`}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button" data-testid="composer-comments-clear" onClick={onClearAll}
          style={{ fontSize: 11, color: 'var(--color-ink-faint)', textDecoration: 'underline', background: 'transparent', border: 'none', cursor: 'pointer' }}
        >全部清除</button>
      </div>
      <div className="ky-scroll" style={{ maxHeight: 170, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {comments.map((c) => (
          <CommentCard
            key={c.id} testId="composer-comment-card"
            file={projectPath ? toMessagePath(c.absPath, projectPath) : c.absPath}
            section={c.section} quote={c.quote} note={c.note}
            onRemove={() => S().removeComment(threadId, c.id)}
          />
        ))}
      </div>
    </div>
  );
}
