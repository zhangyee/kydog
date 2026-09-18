import { useEffect, useRef, type RefObject } from 'react';
import { useBrowserStore } from './browserStore';
import { useConfirmStore } from '../../stores/confirmStore';
import { nextReport, type StageReport } from './stage';

/**
 * 把「舞台」那块空 div 的几何上报给主进程，网页由主进程定位到那里。
 *
 * **判据一条都不在这里**，全在 `stage.ts` 的 `nextReport`（那边有单测；这个仓库的
 * vitest 是 node 环境、没有 jsdom，hook 本身跑不起来）。这里只负责三件事：
 * 什么时候去问一次、去哪儿量、以及卸载时把「收起来了」说出去。
 *
 * ## 可见性 = 挂载与否
 *
 * 侧栏关掉时 `BrowserSidebar` 整个卸载，所以「挂着」就等于 `visible: true`，
 * 收起来那一下由下面的清理函数报一次 `visible: false`。**这一次不能省**：
 * 不报的话主进程手上最后一份上报仍然是可见的，原生 `WebContentsView` 会继续按
 * 那份几何盖在右栏上，而右栏这时已经换回 Inspector 了。主进程只在「渲染层开始重载」
 * 与「渲染进程没了」两个时刻自己 `hideAll()`（`mainWiring.ts`），组件卸载不在其中。
 *
 * ## 什么时候问
 *
 * - `ResizeObserver` 盯舞台元素本身 —— 拖分栏、缩窗口、更新横幅出现／消失，
 *   都会改变这块 div 的尺寸。
 * - `window` 的 `resize` 兜一层：舞台**只平移不改尺寸**的情形 RO 不回调。
 *   今天的布局里想不出这样的情形（右栏宽度固定、右边界贴着窗口边），但这是一个
 *   事件监听不是轮询，留着不花什么，而漏掉一次的表现是网页停在错位置上。
 * - `browserStore` 变了要重问：`epoch` 就是从那里来的，拿到它之前一个字都报不出去。
 * - `confirmStore` 变了要重问：`occluded` 由「有没有 pending 的确认框」算出。
 *
 * ## occluded 为什么只看确认框（spec §2.4 的「单一订阅点」）
 *
 * 全仓只有 `ConfirmDialog` 是**盖住整扇窗口**的浮层（`fixed inset-0`）。
 * `UnsavedChangesModal` 是 `absolute inset-0`、关在中央栏里，盖不到右栏；
 * `OnboardingWizard` 出现时整个 `AppShell` 都不在（`Root` 二选一），侧栏跟着卸载，
 * 走上面那条收尾。2026-09-09 逐个查过 `fixed inset-0` 与 `createPortal` 的每一处，
 * 只有这一个。**别改成「猜哪些浮层会与右栏重叠」** —— 那是拿位置关系当信号，
 * 而这里有一个现成的显式状态可以订阅。
 */
export function useStageBounds(ref: RefObject<HTMLElement | null>): void {
  const lastRef = useRef<StageReport | null>(null);

  useEffect(() => {
    const el = ref.current;
    let visible = true;

    const push = () => {
      const next = nextReport({
        epoch: useBrowserStore.getState().epoch,
        visible,
        occluded: useConfirmStore.getState().request !== null,
        rect: el ? el.getBoundingClientRect() : null,
        last: lastRef.current,
      });
      if (next === null) return;
      lastRef.current = next;
      void window.kydog.invoke('browser.syncView', next)
        .catch((err) => console.error('browser.syncView failed', err));
    };

    const ro = el === null ? null : new ResizeObserver(push);
    if (el !== null) ro?.observe(el);
    window.addEventListener('resize', push);
    const offBrowser = useBrowserStore.subscribe(push);
    const offConfirm = useConfirmStore.subscribe(push);
    push();

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', push);
      offBrowser();
      offConfirm();
      visible = false;
      push();
    };
  }, [ref]);
}
