import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DIVIDER_PX } from './splitPane';

/**
 * 两栏之间的分隔线（对照壳 spec v8 §3.1）：0.5px 发丝线，与胶囊工具栏、Notice 同一条
 * `--color-ink-hair`；hover 变 `--color-ink-soft`，给一点「这条线可以拖」的反馈。命中区
 * DIVIDER_PX 宽、线在正中——线细但好抓。没有危险色，也不需要（CLAUDE.md 的约定）。
 *
 * 拖拽用指针捕获：pointerdown 之后 move / up 都派到这个元素上，指针飞出栏外、飞出窗口也不会
 * 丢事件，不用在 document 上挂全局监听再自己摘。
 *
 * 这里只把 clientX 交出去，比例的换算（clampSplit，含两侧的 MIN_PANE_PX 下限）在调用方——
 * 它才知道 wrapper 的矩形，而这个组件连自己在哪都不该关心。
 */
export function PaneDivider({ onDragTo, onDragEnd, onReset }: {
  onDragTo: (clientX: number) => void;
  onDragEnd: () => void;
  /** 双击分隔线：回到两栏等宽（Yee 2026-09-07：拖过之后要能一下子回正中）。 */
  onReset: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging) onDragTo(e.clientX);
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    onDragEnd();
  };
  // pointercancel 专用（Minor #4，Task 2 审查发现）：这个事件本身就意味着指针已经不再是
  // active pointer 了（系统手势接管、指针离开设备等），规范要求这时候调 releasePointerCapture
  // 会抛 NotFoundError——复用 onUp 的话那次 release 一抛，后面的 setDragging(false) /
  // onDragEnd() 就执行不到，wrapper 的 user-select: none 与线的 hover 态会一直卡到下一次
  // pointerdown 才解开。不 release（指针已经不需要释放）、只收自己的状态。
  const onCancel = () => {
    if (!dragging) return;
    setDragging(false);
    onDragEnd();
  };

  return (
    <div
      data-testid="pdf-pane-divider"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onDoubleClick={onReset}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{ flex: `0 0 ${DIVIDER_PX}px`, position: 'relative', cursor: 'col-resize', zIndex: 2 }}
    >
      <div
        style={{
          position: 'absolute', top: 0, bottom: 0, left: '50%', width: 0.5, marginLeft: -0.25,
          background: hover || dragging ? 'var(--color-ink-soft)' : 'var(--color-ink-hair)',
        }}
      />
    </div>
  );
}
