import { IconButton, NavIcon } from '../../shared';
import { PANEL_SHADOW } from './pdf/PdfToolCard';

/**
 * 「跳到最新」——浮在输入框正上方、居中的一颗圆钮（材质同 md / PDF 胶囊：纸色底、0.5px 发丝边、
 * 胶囊阴影）。
 *
 * **只在没贴底时渲染**（`ThreadView` 按 `useAutoScroll` 的 `following` 判），所以它出现本身就是
 * 「你现在不在最新处」这条信息，不需要再挂一个「有新消息」的角标去数新内容 —— 那个数没有协议层
 * 依据（一段文字算一条还是一块算一条？），而按钮在不在场是确定的。
 *
 * `bottom: 100%` 把它整个顶到父层（输入框那一块）上边缘之上：父层带着 `marginTop:
 * -COMPOSER_FADE_HEIGHT`，上边缘就是渐变条的起点，所以按钮落在消息流上、不压住输入框。
 * 外层不吃指针事件，只有按钮本身吃 —— 免得这条透明横带挡住下面消息的选中与点击。
 */
export function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <div
      data-testid="jump-to-latest-row"
      style={{
        position: 'absolute', left: 0, right: 0, bottom: '100%', marginBottom: 8,
        display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 6,
      }}
    >
      <span
        style={{
          display: 'inline-flex', borderRadius: 999, pointerEvents: 'auto',
          background: 'var(--color-paper)', border: '0.5px solid var(--color-ink-hair)',
          boxShadow: PANEL_SHADOW,
        }}
      >
        <IconButton size={28} testId="jump-to-latest" tooltip="跳到最新" tooltipPlacement="top" onClick={onClick}>
          <NavIcon name="chevron-down" size={15} />
        </IconButton>
      </span>
    </div>
  );
}
