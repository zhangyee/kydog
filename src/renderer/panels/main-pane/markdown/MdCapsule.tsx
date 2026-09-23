import { useRef, type ReactNode } from 'react';
import { IconButton, NavIcon, Tooltip } from '../../../shared';
import { PANEL_SHADOW } from '../pdf/PdfToolCard';

type Props = {
  commentMode: boolean; canComment: boolean; onToggleComment: () => void;
  exportOpen: boolean; exporting: boolean; onToggleExport: () => void;
  /** 设置卡（MarkdownFileTab 组好传进来），挂在分享键那一格里、锚在它正上方。传的是渲染函数：
   *  卡片要知道「分享键 + 卡片」那一格的 DOM（boundary），点在这一格里不算点卡片外。 */
  renderExportCard?: (boundary: { current: HTMLElement | null }) => ReactNode;
};

/**
 * md 标签页底部居中的胶囊（spec §2.1）：材质 / 位置 / 高度照 PdfToolbar。评论键 · 发丝线 · 分享键。
 */
export function MdCapsule({ commentMode, canComment, onToggleComment, exportOpen, exporting, onToggleExport, renderExportCard }: Props) {
  const exportCellRef = useRef<HTMLSpanElement>(null);
  const button = (
    <IconButton
      size={28} tooltipPlacement="top" testId="md-comment-mode"
      tooltip={canComment ? '评论' : '先打开一个对话'}
      disabled={!canComment} active={commentMode} activeVariant="accent" tone={commentMode ? 'ink' : 'default'}
      onClick={onToggleComment}
    >
      <NavIcon name="message-square-plus" size={15} />
    </IconButton>
  );
  const shareButton = (
    <IconButton
      size={28} tooltipPlacement="top" testId="md-export"
      tooltip={exporting ? '正在导出…' : '导出 PDF'}
      disabled={exporting} active={exportOpen} activeVariant="accent" tone={exportOpen ? 'ink' : 'default'}
      onClick={onToggleExport}
    >
      {exporting ? spinner() : <NavIcon name="share" size={15} />}
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
        <span aria-hidden style={{ width: 0.5, height: 16, background: 'var(--color-ink-hair)', margin: '0 4px' }} />
        <span ref={exportCellRef} data-testid="md-export-cell" style={{ position: 'relative', display: 'inline-flex' }}>
          {exporting ? <Tooltip content="正在导出…" placement="top">{shareButton}</Tooltip> : shareButton}
          {exportOpen && !exporting ? renderExportCard?.(exportCellRef) : null}
        </span>
      </div>
    </div>
  );
}

// spinner() 是普通函数、返回元素，不是组件：miniReact 不展开子组件，写成组件测试就看不到里面的 testid。
function spinner() {
  return (
    <svg
      className="animate-spin" width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}
      data-testid="md-export-spinner"
    >
      <circle cx={12} cy={12} r={10} opacity={0.25} />
      <path d="M22 12a10 10 0 0 1-10 10" strokeLinecap="round" />
    </svg>
  );
}
