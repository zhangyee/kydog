/**
 * 覆盖式滚动条的几何（spec 2026-09-06 §2）。纯函数：组件与 e2e 都从这里取同一份映射，
 * 拖拽反算与位置正算互逆由单测钉住。
 */
export const THUMB_PX = 7;
export const THUMB_HOVER_PX = 11;
export const THUMB_MIN_PX = 24;
export const THUMB_INSET_PX = 2;
/** 最后一次 scroll 事件之后多久淡出。 */
export const FADE_MS = 1000;

export type ThumbInput = { clientLen: number; scrollLen: number; scrollPos: number; trackLen: number };
export type Thumb = { len: number; pos: number };

/** 不能滚（内容不比视口长）或轨道没长度 → null，调用方不渲染这一条。 */
export function thumbGeometry(i: ThumbInput): Thumb | null {
  if (!(i.scrollLen > i.clientLen) || i.trackLen <= 0) return null;
  const len = Math.min(i.trackLen, Math.max(THUMB_MIN_PX, (i.clientLen / i.scrollLen) * i.trackLen));
  const range = i.trackLen - len;
  const maxScroll = i.scrollLen - i.clientLen;
  const pos = range <= 0 ? 0 : Math.min(range, Math.max(0, (i.scrollPos / maxScroll) * range));
  return { len, pos };
}

/** 拇指被拖到 thumbPos（轨道内像素）时视口该滚到哪。与 thumbGeometry 互逆，两端钳住。 */
export function scrollPosForThumb(i: Omit<ThumbInput, 'scrollPos'>, thumbPos: number): number {
  const g = thumbGeometry({ ...i, scrollPos: 0 });
  if (!g) return 0;
  const range = i.trackLen - g.len;
  if (range <= 0) return 0;
  const maxScroll = i.scrollLen - i.clientLen;
  return Math.min(maxScroll, Math.max(0, (thumbPos / range) * maxScroll));
}
