import type { EventPayload, EventTopic } from '../../../shared/protocol';
import type { BrowserState } from '../../../shared/types';
import type { BrowserStoreState } from './browserStore';

/**
 * 内置浏览器在渲染层的**接线**：订阅两条广播 + 走一次恢复协议。
 *
 * **拆出来只为一件事：让它能被用例碰到。** `bootstrap.ts` 里没有一行是单测够得着的
 * （它一上来就 `window.kydog.invoke('app.bootstrap')`），而这几句全都是「挂在哪、
 * 按什么顺序」—— 接错既不会编译报错，也不会有任何用例红，只会悄悄不工作。
 * 主进程那边同样的理由已经把 `main.ts` 的三处接线拆成了 `browser/mainWiring.ts`，
 * 这是渲染层这一侧的同一件事。
 *
 * 第二轮变异实测：把 `getState` 挪到订阅之前、或者把两条订阅改成空函数，
 * 三条 gate **全绿**（N14 / N15 / N16）。这个模块与它的用例就是为了把那三条堵上。
 *
 * ## 恢复协议：先订阅 → `browser.getState` → 按 `revision` 去旧
 *
 * 顺序不能反：
 *  · 先 `getState` 再订阅 → 两者之间到达的 `browser.tabsChanged` 没人接，界面停在
 *    一份稍旧的清单上，直到下一次真实变更；
 *  · 只订阅不 `getState` → 渲染进程重载后若标签一直没有新变化，就再也收不到任何东西，
 *    镜像会一直是空的。而且 **epoch 只从 `getState` 来**（广播里刻意不带），
 *    拿不到它，`useStageBounds` 报的每一次 `syncView` 都被主进程判为过期，
 *    侧栏里那块网页永远不可见 —— 全程没有任何错误。
 *
 * 先订阅则可能先收到比快照**新**的帧，那一侧由 `applySnapshot` 的 revision 闸去旧
 * （epoch 走的是另一道闸，见 `browserStore` 的文件头）。
 */

/** `window.kydog` 里这一层用得上的两个方法。替身不必去实现整个 bridge。 */
export type BrowserBridgePorts = {
  on<T extends EventTopic>(topic: T, listener: (payload: EventPayload<T>) => void): () => void;
  invoke(method: 'browser.getState'): Promise<BrowserState>;
};

/** 镜像那一侧的三个写口。 */
export type BrowserSink = Pick<BrowserStoreState, 'applySnapshot' | 'applyTabs' | 'applyAgentFocus'>;

export function installBrowserBridge(bridge: BrowserBridgePorts, sink: BrowserSink): void {
  // 标签清单：全量一帧，**不含 epoch**（广播里刻意不带，见 BrowserTabsSnapshot）。
  bridge.on('browser.tabsChanged', (p) => sink.applyTabs(p));
  // agent 在驱动哪个标签。**单独一条 topic**，不搭标签广播的顺风车 ——
  // `setAgentActive` 刻意不推 revision、`toState()` 又把 `isAgentActive` 抹掉，
  // 那条广播在类型上和运行时都带不出这个信号。
  bridge.on('browser.agentFocus', (p) => sink.applyAgentFocus(p));

  // **必须排在两条订阅之后。** 不 await：它只影响侧栏，不该把启动挡在一次 IPC 后面。
  // 失败也不能掀翻调用方 —— 那时侧栏是空的，但别的东西照常。
  void bridge.invoke('browser.getState')
    .then((st) => sink.applySnapshot(st))
    .catch((err: unknown) => console.error('browser.getState failed', err));
}
