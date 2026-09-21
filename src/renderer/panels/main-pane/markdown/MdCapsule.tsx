import { IconButton, NavIcon } from '../../../shared';
import { PANEL_SHADOW } from '../pdf/PdfToolCard';

type Props = { commentMode: boolean; canComment: boolean; onToggleComment: () => void };

/**
 * md 标签页底部居中的胶囊（spec §2.1）：材质 / 位置 / 高度照 PdfToolbar。本期只有评论键；
 * md 导出 PDF（spec ③）往这里加一条发丝线和分享键。
 */
export function MdCapsule({ commentMode, canComment, onToggleComment }: Props) {
  return (
    <div
      data-testid="md-capsule" data-comment-mode={commentMode ? 'on' : 'off'}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 16, display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 5 }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 2, padding: '4px 6px', borderRadius: 999,
          background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)', boxShadow: PANEL_SHADOW,
          pointerEvents: 'auto',
        }}
      >
        <IconButton
          size={28} tooltipPlacement="top" testId="md-comment-mode"
          tooltip={canComment ? '评论模式' : '先打开一个对话'}
          disabled={!canComment} active={commentMode} tone={commentMode ? 'ink' : 'default'}
          onClick={onToggleComment}
        >
          <NavIcon name="message-square-plus" size={15} />
        </IconButton>
      </div>
    </div>
  );
}
