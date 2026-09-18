import { useEffect, useState } from 'react';
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

/** 自动滚动要读写的那三样。`HTMLElement` 结构上就满足它。 */
export type ScrollBox = {
  readonly scrollHeight: number;
  readonly clientHeight: number;
  scrollTop: number;
};

/**
 * 贴底跟随的判定状态机：不碰 React、不碰 DOM，只读写传进来的 `ScrollBox`，
 * 所以能脱离浏览器单测。`useAutoScroll` 只负责把 React 的时机接到这三个方法上。
 *
 * 状态是 `sticky`（初始 true）加上「状态机最后一次写入 / 观察到的位置」`known`：
 * - `onScroll`：每次滚动后从位置反推 —— 离底 < STICKY_THRESHOLD_PX 才算贴底
 * - `afterRender`：sticky 才跟到底；不 sticky（用户在往回翻）就一动不动
 * - `jumpToBottom`：override，无条件跳底并恢复 sticky
 *
 * **为什么要记 `known`**：scrollTop 被改（用户第一下滚轮、程序赋值）之后，scroll 事件要到下一帧
 * 才派发；这中间流式输出完全可能先提交一次渲染。只看 sticky 的话，afterRender 会把用户刚滚走的
 * 位置拉回底部。判据是协议层事实：scrollTop 与状态机自己记下的不一样 = 有人动过它、事件还在路上，
 * 这时先就地重判 sticky。
 *
 * 重判时拿「动之前」与「现在」两份内容里矮的那份当底：内容长高了，用户是对着长高之前的内容滚的；
 * 内容变矮了，浏览器会把 scrollTop 夹到新的底上 —— 那是被夹的，不是用户翻走。
 */
export function createStickyScroll() {
  let sticky = true;
  /** 状态机最后一次写入（写完回读 —— 浏览器会夹值）或从 scroll 事件观察到的位置。 */
  let known: { scrollTop: number; scrollHeight: number } | null = null;
  const remember = (box: ScrollBox) => { known = { scrollTop: box.scrollTop, scrollHeight: box.scrollHeight }; };

  return {
    get sticky(): boolean { return sticky; },
    onScroll(box: ScrollBox): void {
      sticky = isNearBottom(box);
      remember(box);
    },
    afterRender(box: ScrollBox): void {
      if (known !== null && box.scrollTop !== known.scrollTop) {
        sticky = isNearBottom({
          scrollHeight: Math.min(known.scrollHeight, box.scrollHeight),
          clientHeight: box.clientHeight,
          scrollTop: box.scrollTop,
        });
      }
      if (sticky) box.scrollTop = box.scrollHeight;
      remember(box);
    },
    jumpToBottom(box: ScrollBox): void {
      box.scrollTop = box.scrollHeight;
      sticky = true;
      remember(box);
    },
  };
}

export type StickyScroll = ReturnType<typeof createStickyScroll>;

export function useAutoScroll(
  scrollRef: RefObject<HTMLElement | null>,
  tailSignal: number,
  threadId: string,
): void {
  // 惰性初始化，只建一次：之后每次渲染拿到的都是同一个实例
  const [sticky] = useState(createStickyScroll);

  // 监听用户/程序滚动：每次滚动后从位置反推 sticky
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => sticky.onScroll(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, sticky]);

  // 每次渲染后：若 sticky 则跟随到底（无 deps useEffect 每次渲染都跑）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    sticky.afterRender(el);
  });

  // tailSignal 变化（新 text block / 新 user message）→ 强制跳底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    sticky.jumpToBottom(el);
  }, [tailSignal, scrollRef, sticky]);

  // threadId 变化 → 强制跳底（MainPane 不给 ThreadView 加 key，组件不会重挂）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    sticky.jumpToBottom(el);
  }, [threadId, scrollRef, sticky]);
}
