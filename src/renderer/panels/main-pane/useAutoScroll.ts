import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export const STICKY_THRESHOLD_PX = 64;

export function isNearBottom(opts: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}): boolean {
  const { scrollHeight, clientHeight, scrollTop } = opts;
  return scrollHeight - clientHeight - scrollTop < STICKY_THRESHOLD_PX;
}

export function useAutoScroll(
  scrollRef: RefObject<HTMLElement | null>,
  tailSignal: number,
  threadId: string,
): void {
  const stickyRef = useRef(true);

  // 监听用户/程序滚动：每次滚动后从位置反推 sticky
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      stickyRef.current = isNearBottom({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollTop: el.scrollTop,
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  // 每次渲染后：若 sticky 则跟随到底（无 deps useEffect 每次渲染都跑）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickyRef.current) el.scrollTop = el.scrollHeight;
  });

  // tailSignal 变化（新 text block / 新 user message）→ 强制跳底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickyRef.current = true;
  }, [tailSignal, scrollRef]);

  // threadId 变化 → 强制跳底（MainPane 不给 ThreadView 加 key，组件不会重挂）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickyRef.current = true;
  }, [threadId, scrollRef]);
}
