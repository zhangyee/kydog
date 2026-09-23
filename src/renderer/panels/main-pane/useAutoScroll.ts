import { useCallback, useEffect, useRef, useState } from 'react';
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

export type AutoScroll = {
  /** 现在是否跟随最新。false = 用户翻上去了，新内容不会把他拽回来。 */
  following: boolean;
  /** 跳到最新并恢复跟随（输入框上方那颗箭头按的就是它）。 */
  jumpToBottom: () => void;
};

/**
 * @param jumpSignal 变化一次就**无条件**跳底一次。今天只数「用户自己发出的消息」——
 *   按了发送就该看到它落在最新。**助手的输出不进这个数**：它靠 `afterRender` 跟随，
 *   贴着底时照样跟，翻走了就一动不动。以前这里连 assistant 的 text block 一起数，于是
 *   skill 跑长活时每落一段新文字就把正在往回翻的人弹到底部。
 */
export function useAutoScroll(
  scrollRef: RefObject<HTMLElement | null>,
  jumpSignal: number,
  threadId: string,
): AutoScroll {
  // 惰性初始化，只建一次：之后每次渲染拿到的都是同一个实例
  const [sticky] = useState(createStickyScroll);
  // 状态机的判定在 React 之外，按钮要按它显示/隐藏，所以每次改完同步一份进来。
  // 值没变时 setState 会被 React 直接丢掉，不会多一次渲染（afterRender 每渲染都跑，
  // 靠的就是这一点，不然就是自激）。
  const [following, setFollowing] = useState(true);
  const sync = useCallback(() => { setFollowing(sticky.sticky); }, [sticky]);

  /** 当前挂着 scroll 监听的那个元素，以及挂上去的那个函数。 */
  const listening = useRef<{ el: HTMLElement; onScroll: () => void } | null>(null);

  // 每次渲染后：先确认监听挂在**现在**这个滚动容器上，再跟随（无 deps useEffect 每次渲染都跑）。
  //
  // **监听不能只在挂载时挂一次**：滚动容器不一定那时就在。新建的对话先渲染的是空状态，
  // 消息列表要等第一条消息才出现 —— 挂载时 `scrollRef.current` 是 null，一个只跑一次的
  // effect 就此再也不会回来，之后用户怎么翻都没人告诉状态机，「跳到最新」那颗按钮永远不出现
  // （2026-09-23 实测，e2e 27-composer 那条用例逮到的就是它）。
  // 判据同状态机那套：拿「记着的」和「现在的」比 —— 不一样就重挂。
  useEffect(() => {
    const el = scrollRef.current;
    const prev = listening.current;
    if (prev?.el !== el) {
      if (prev) prev.el.removeEventListener('scroll', prev.onScroll);
      if (el) {
        const onScroll = () => { sticky.onScroll(el); sync(); };
        el.addEventListener('scroll', onScroll, { passive: true });
        listening.current = { el, onScroll };
      } else {
        listening.current = null;
      }
    }
    if (!el) return;
    sticky.afterRender(el);
    sync();
  });

  // 卸载时摘掉监听。挂/摘不在同一个 effect 里：上面那个每次渲染都跑，把 cleanup 写在它身上
  // 等于每渲染一次就摘一次挂一次。
  useEffect(() => () => {
    const prev = listening.current;
    if (prev) prev.el.removeEventListener('scroll', prev.onScroll);
    listening.current = null;
  }, []);

  // jumpSignal 变化（用户发出新消息）→ 强制跳底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    sticky.jumpToBottom(el);
    sync();
  }, [jumpSignal, scrollRef, sticky, sync]);

  // threadId 变化 → 强制跳底（MainPane 不给 ThreadView 加 key，组件不会重挂）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    sticky.jumpToBottom(el);
    sync();
  }, [threadId, scrollRef, sticky, sync]);

  const jumpToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    sticky.jumpToBottom(el);
    sync();
  }, [scrollRef, sticky, sync]);

  return { following, jumpToBottom };
}
