import { IconButton, NavIcon, Tooltip } from '../../../shared';
import { PANEL_SHADOW } from '../pdf/PdfToolCard';

type Props = { commentMode: boolean; canComment: boolean; onToggleComment: () => void };

/**
 * md 标签页底部居中的胶囊（spec §2.1）：材质 / 位置 / 高度照 PdfToolbar。本期只有评论键；
 * md 导出 PDF（spec ③）往这里加一条发丝线和分享键。
 */
export function MdCapsule({ commentMode, canComment, onToggleComment }: Props) {
  const button = (
    <IconButton
      size={28} tooltipPlacement="top" testId="md-comment-mode"
      tooltip={canComment ? '评论模式' : '先打开一个对话'}
      disabled={!canComment} active={commentMode} tone={commentMode ? 'ink' : 'default'}
      onClick={onToggleComment}
    >
      <NavIcon name="message-square-plus" size={15} />
    </IconButton>
  );
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
        {/* IconButton 自己只在「有 tooltip 且没 disabled」时才包一层 Tooltip（见 IconButton.tsx），
            没对话时按钮是 disabled，落进这条缝——它上面的 tooltip 永远不会渲染。这里手动在外面
            再包一层 Tooltip 补上「先打开一个对话」；Tooltip 的 hover 监听挂在外层 span 上，
            对里面 disabled 的按钮照样生效（disabled 元素自己不派发 mouseenter/mouseleave）。
            有对话时用 IconButton 自带的那套就够，不用再包一层。 */}
        {canComment ? button : <Tooltip content="先打开一个对话" placement="top">{button}</Tooltip>}
      </div>
    </div>
  );
}
