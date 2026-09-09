import { create } from 'zustand';
import type { BrowserState, BrowserTabInfo, BrowserTabsSnapshot } from '../../../shared/types';
import type { EventPayload } from '../../../shared/protocol';

/**
 * 内置浏览器在渲染层的镜像。**主进程才是真相** —— 这里只存它广播过来的东西，
 * 一个字段都不自己算。
 *
 * ## 恢复协议：先订阅 → `browser.getState` → 按 `revision` 去旧
 *
 * 顺序不能反。先 `getState` 再订阅的话，两者之间到达的事件没人接；先订阅则可能
 * 先收到比快照**新**的帧，靠 `revision` 去旧。渲染进程重载后若标签一直没有新变化，
 * 光订阅是永远收不到任何东西的 —— 所以 `getState` 那一次全量起点必须有。
 *
 * ## 为什么 `revision` 与 `epoch` 分成两道闸
 *
 * **这是本模块最容易写错的一处，写错了没有任何东西会报错。**
 *
 * `browser.getState` 的 handler 会**先 `newEpoch()` 再取快照**，而 `newEpoch()`
 * 自己会推进 revision 并顺带广播一帧 `browser.tabsChanged`。于是那一帧广播与
 * getState 的返回值**带着同一个 revision**，只是前者没有 epoch（广播里刻意不带，
 * 见 `BrowserTabsSnapshot` 的注释）。
 *
 * 两者到达顺序没有保证。广播先到时，`revision` 已经被推到 N；紧接着 getState 的
 * 返回值也是 N —— 如果 epoch 跟 tabs 共用同一道 `revision >` 闸，**这一份 epoch 会
 * 被当成旧帧丢掉**，`useStageBounds` 手上就永远没有可用的 epoch，它上报的每一次
 * `syncView` 都会被主进程判为过期，侧栏里那块网页永远拿不到 bounds、一直不可见。
 * 全程没有错误、没有警告。
 *
 * 所以：**epoch 只认 epoch 自己的大小**（主进程里是 `this.ep += 1`，单调递增，
 * 是协议层事实，不是「猜它应该更大」），tabs 认 revision。两道闸互不干涉。
 */

/**
 * agent 焦点广播的载荷。**直接取协议里那一条，不再手抄一份**。
 *
 * 手抄的那份挡得住改名/改类型（`browserBridge.ts` 那一行会红），挡不住主进程
 * **加字段** —— 渲染层静默忽略，无害但也是一份会漂的真相。协议是单一出处，
 * 取它零成本。
 */
export type AgentFocusPayload = EventPayload<'browser.agentFocus'>;

/**
 * 「还没拿到过 epoch」。主进程的 epoch 从 0 起、第一次 `newEpoch()` 给的是 1，
 * 所以 0 永远不会是一个有效代号 —— 拿它上报必被判过期。
 * `useStageBounds` 据此决定「现在还不能上报」。
 */
export const NO_EPOCH = 0;

export type BrowserStoreState = {
  /** 主进程的标签账本版本号。初值 -1：主进程第一次广播时它已经 ≥ 0。 */
  revision: number;
  epoch: number;
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  /**
   * agent 此刻在驱动哪些标签，值是给人看的动作名（主进程没说就是 `null`）。
   *
   * **是集合不是计数器。** 嵌套驱动（两个驱动帧先后握住同一个标签）会发两次
   * `active: true`、只发一次 `active: false`，当计数器用会卡在「亮着」。
   */
  agentTabs: ReadonlyMap<string, string | null>;
  /** `browser.getState` 的返回值。**唯一的 epoch 来源。** */
  applySnapshot: (next: BrowserState) => void;
  /** `browser.tabsChanged` 广播。**不带 epoch，也不许碰 epoch。** */
  applyTabs: (next: BrowserTabsSnapshot) => void;
  /** `browser.agentFocus` 广播。**不推 revision** —— 主进程那一侧也不推。 */
  applyAgentFocus: (p: AgentFocusPayload) => void;
};

const EMPTY_AGENT: ReadonlyMap<string, string | null> = new Map();

/**
 * 把已经不在标签清单里的驱动记录剪掉。
 *
 * **这是「标签在被驱动期间消失」那一支唯一的清除信号。** 主进程那边的熄灯发不出来：
 * `destroyView` 里有一句 `for (const f of this.drivingFrames) f.tabs.delete(id)`，
 * 标签在 `withAgentDriving` 收尾之前就从驱动帧里摘掉了，那个 `finally` 遍历不到它
 *（`browserService.test.ts`「驱动期间标签被销毁」那条把这个缝钉住了）。
 * 不剪的话，那条记录再没有人会来清 —— 换一个标签复用同一个 id 是不可能的
 *（id 带 uuid），但那张表会无限长，而且一旦主进程将来复用 id 就会亮错灯。
 *
 * 没有可剪的就原样返回同一个引用：zustand 是按引用比的，每次换新 Map 会让
 * 订阅它的组件每收一帧标签广播就重渲染一次。
 */
function pruneAgentTabs(
  cur: ReadonlyMap<string, string | null>,
  tabs: BrowserTabInfo[],
): ReadonlyMap<string, string | null> {
  if (cur.size === 0) return cur;
  const live = new Set(tabs.map((t) => t.id));
  let stale = false;
  for (const id of cur.keys()) if (!live.has(id)) { stale = true; break; }
  if (!stale) return cur;
  const next = new Map<string, string | null>();
  for (const [id, action] of cur) if (live.has(id)) next.set(id, action);
  return next;
}

export const useBrowserStore = create<BrowserStoreState>((set) => ({
  revision: -1,
  epoch: NO_EPOCH,
  tabs: [],
  activeTabId: null,
  agentTabs: EMPTY_AGENT,

  applySnapshot: (next) => set((cur) => ({
    // epoch 单调递增，只跟自己比。**别并进下面那道 revision 闸**（见文件头）。
    epoch: next.epoch > cur.epoch ? next.epoch : cur.epoch,
    ...(next.revision > cur.revision
      ? {
        revision: next.revision,
        tabs: next.tabs,
        activeTabId: next.activeTabId,
        agentTabs: pruneAgentTabs(cur.agentTabs, next.tabs),
      }
      : {}),
  })),

  applyTabs: (next) => set((cur) => (next.revision > cur.revision
    ? {
      revision: next.revision,
      tabs: next.tabs,
      activeTabId: next.activeTabId,
      agentTabs: pruneAgentTabs(cur.agentTabs, next.tabs),
    }
    : {})),

  applyAgentFocus: (p) => set((cur) => {
    // `tabId: null` = 一次把全部熄掉。协议上留着这一支，今天没有发送方走它。
    if (p.tabId === null) return cur.agentTabs.size === 0 ? {} : { agentTabs: EMPTY_AGENT };
    const action = p.action ?? null;
    if (p.active) {
      if (cur.agentTabs.get(p.tabId) === action) return {};
      const next = new Map(cur.agentTabs);
      next.set(p.tabId, action);
      return { agentTabs: next };
    }
    if (!cur.agentTabs.has(p.tabId)) return {};
    const next = new Map(cur.agentTabs);
    next.delete(p.tabId);
    return { agentTabs: next };
  }),
}));

/**
 * 侧栏顶部那条横幅要不要出、说什么。
 *
 * **判据是「用户眼前这一页正在被 agent 操作」**，不是「有任何标签在被操作」：
 * 横幅的话是「别动它」，而用户碰不到的后台标签不需要这句话 —— 那一个由标签条上的
 * 指示灯负责。两件事各有各的信号，别让横幅去替指示灯说话。
 */
export function agentBanner(
  s: Pick<BrowserStoreState, 'activeTabId' | 'agentTabs'>,
): { tabId: string; action: string | null } | null {
  if (s.activeTabId === null) return null;
  if (!s.agentTabs.has(s.activeTabId)) return null;
  return { tabId: s.activeTabId, action: s.agentTabs.get(s.activeTabId) ?? null };
}
