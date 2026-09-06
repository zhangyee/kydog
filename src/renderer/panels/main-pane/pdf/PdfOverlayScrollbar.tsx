import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import {
  FADE_MS, THUMB_HOVER_PX, THUMB_INSET_PX, THUMB_PX, scrollPosForThumb, thumbGeometry, type Thumb,
} from './overlayScrollbar';

type Props = { targetRef: RefObject<HTMLElement | null>; axis: 'y' | 'x'; testId: string };

/**
 * 一条轴的覆盖式拇指（spec 2026-09-06 §2）。放在滚动容器的**兄弟**位置、父层 position: relative。
 *
 * 它只读写 target 自己的 scrollTop / scrollLeft：另一栏由 scrollSync 照常镜像，回声锁照常生效
 * ——覆盖层不参与同步，只是滚动位置的又一个读写方（不变量 #2）。
 *
 * 显隐：target 的 scroll 事件出现、FADE_MS 后淡出；指针悬停在拇指上或正在拖拽时保持可见并变粗。
 * 尺寸重算：scroll 事件、target 与其第一个子元素的 ResizeObserver（内容高随缩放变、栏随窗口 /
 * 分隔线变，两者都不是 scroll 事件）。
 */
export function OverlayScrollbar({ targetRef, axis, testId }: Props) {
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [hasOther, setHasOther] = useState(false);   // 另一条轴也能滚 → 角上让位
  const [visible, setVisible] = useState(false);
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const timer = useRef<number | null>(null);
  const dragStart = useRef<{ pointer: number; pos: number } | null>(null);
  const vertical = axis === 'y';

  const trackLenOf = (el: HTMLElement, other: boolean) =>
    (vertical ? el.clientHeight : el.clientWidth) - 2 * THUMB_INSET_PX - (other ? THUMB_HOVER_PX : 0);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const measure = () => {
      const other = vertical
        ? target.scrollWidth > target.clientWidth
        : target.scrollHeight > target.clientHeight;
      setHasOther(other);
      setThumb(thumbGeometry({
        clientLen: vertical ? target.clientHeight : target.clientWidth,
        scrollLen: vertical ? target.scrollHeight : target.scrollWidth,
        scrollPos: vertical ? target.scrollTop : target.scrollLeft,
        trackLen: trackLenOf(target, other),
      }));
    };
    const show = () => {
      measure();
      setVisible(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => { timer.current = null; setVisible(false); }, FADE_MS);
    };
    measure();
    target.addEventListener('scroll', show, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(target);
    if (target.firstElementChild) ro.observe(target.firstElementChild);
    return () => {
      target.removeEventListener('scroll', show);
      ro.disconnect();
      if (timer.current !== null) { window.clearTimeout(timer.current); timer.current = null; }
    };
    // vertical 由 axis 决定；trackLenOf 是无状态的箭头函数（这个项目的 ESLint 配置未启用
    // react-hooks/exhaustive-deps，故无需 disable 注释）。
  }, [targetRef, axis]);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!thumb) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { pointer: vertical ? e.clientY : e.clientX, pos: thumb.pos };
    setDragging(true);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const target = targetRef.current;
    if (!dragging || !target || !dragStart.current) return;
    const delta = (vertical ? e.clientY : e.clientX) - dragStart.current.pointer;
    const next = scrollPosForThumb({
      clientLen: vertical ? target.clientHeight : target.clientWidth,
      scrollLen: vertical ? target.scrollHeight : target.scrollWidth,
      trackLen: trackLenOf(target, hasOther),
    }, dragStart.current.pos + delta);
    if (vertical) target.scrollTop = next; else target.scrollLeft = next;
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    dragStart.current = null;
  };
  // pointercancel 不 release（指针已不是 active pointer，release 会抛 NotFoundError）——同 PaneDivider。
  const onCancel = () => {
    if (!dragging) return;
    setDragging(false);
    dragStart.current = null;
  };

  if (!thumb) return null;
  const thick = hover || dragging ? THUMB_HOVER_PX : THUMB_PX;
  const shown = visible || hover || dragging;
  const box: CSSProperties = vertical
    ? { top: THUMB_INSET_PX + thumb.pos, right: THUMB_INSET_PX, width: thick, height: thumb.len }
    : { left: THUMB_INSET_PX + thumb.pos, bottom: THUMB_INSET_PX, height: thick, width: thumb.len };
  return (
    <div
      data-testid={testId}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onCancel}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'absolute', ...box, borderRadius: thick / 2, zIndex: 3,
        background: hover || dragging ? 'var(--color-ink-soft)' : 'var(--color-ink-faint)',
        opacity: shown ? 1 : 0,
        transition: 'opacity 250ms, width 120ms, height 120ms',
        pointerEvents: shown ? 'auto' : 'none', touchAction: 'none', cursor: 'default',
      }}
    />
  );
}
