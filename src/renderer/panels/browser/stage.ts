import { MIN_BROWSER_WIDTH } from '../../../shared/types';
import { NO_EPOCH } from './browserStore';
import type { RectDip } from '../../../shared/types';

/**
 * 「舞台」几何的纯算术。**从 `useStageBounds` 里抠出来，因为 hook 本身测不到**
 * —— 这个仓库的 vitest 跑在 node 环境、没有 jsdom，也没有 React 测试库，
 * 组件与 hook 只能靠 e2e 覆盖。凡是判据都放在这里，让它被单测钉住。
 */

/** 一次上报的全部内容，与 `browser.syncView` 的 args 逐字段对应。 */
export type StageReport = { epoch: number; visible: boolean; occluded: boolean; bounds: RectDip };

/**
 * `getBoundingClientRect()` → `RectDip`。
 *
 * 渲染层的视口坐标与 `WebContentsView.setBounds` 的坐标系是同一个：三个平台的
 * 窗口边框（darwin `hiddenInset` / win32 `hidden` + overlay / linux 原生边框）
 * 都在 `contentView` 之外，渲染层铺满整个 contentView。所以这里不需要任何偏移量。
 *
 * **往里取整，不是四舍五入**：左上角向上取整、右下角向下取整。原生层永远盖在 DOM
 * 之上，取大了就会压住旁边那条分栏手柄与标签条的边线（一个像素的黑边，且鼠标点不到
 * 手柄）。取小了最多在边上露出半个像素的底色 —— 两个方向的代价不对称。
 *
 * 负数宽高钳到 0：元素被 `display:none` 或者窗口缩到极小时 rect 会塌，
 * 负数交给主进程会变成一个诡异的 setBounds。
 */
export function toStageBounds(r: { left: number; top: number; width: number; height: number }): RectDip {
  const x = Math.ceil(r.left);
  const y = Math.ceil(r.top);
  return {
    x,
    y,
    width: Math.max(0, Math.floor(r.left + r.width) - x),
    height: Math.max(0, Math.floor(r.top + r.height) - y),
  };
}

/**
 * 这一次上报与上一次是同一件事吗。
 *
 * 去重不是为了省 IPC 的字节，是为了**别把一次拖拽变成几百次 `setDeviceMetricsOverride`**
 * —— 那条命令要过 CDP，每次都会让页面重新布局。ResizeObserver 在一次拖拽里会连着
 * 回调几十上百次，其中大量是同一个整数尺寸（浏览器按设备像素回调，取整之后是同一个数）。
 */
export function sameReport(a: StageReport | null, b: StageReport): boolean {
  return a !== null
    && a.epoch === b.epoch
    && a.visible === b.visible
    && a.occluded === b.occluded
    && a.bounds.x === b.bounds.x
    && a.bounds.y === b.bounds.y
    && a.bounds.width === b.bounds.width
    && a.bounds.height === b.bounds.height;
}

/**
 * 侧栏宽度的下限，**拖拽时当场钳**。
 *
 * 不当场钳的话，拖出界的那一帧会以非法宽度上报 `syncView`，主进程照单全收把网页
 * 定位过去；要等到落盘往返（`settingsService.update` 的 `sanitizeBrowserWidth`）
 * 才被拉回来，而那条路是 fire-and-forget 的。下限的值与主进程用的是**同一个常量**
 * （`shared/types.ts`），两边各写一个字面量就是两份会漂的真相。
 */
export function clampBrowserWidth(w: number): number {
  if (!Number.isFinite(w)) return MIN_BROWSER_WIDTH;
  return Math.max(MIN_BROWSER_WIDTH, Math.round(w));
}

/**
 * 这一帧到底该不该上报、报什么。**整个 `useStageBounds` 的判据都在这里**，
 * hook 那边只剩「什么时候来问一次」。
 *
 * 逐条的理由（每一条都有一个具体的坏结果）：
 *
 * - **没有 epoch 就一个字都别报。** 主进程 `syncView` 第一句就是
 *   `if (args.epoch !== 现在的 epoch) return`，拿 `NO_EPOCH`（0）去报必被丢弃，
 *   只是白跑一趟 IPC。真正的 epoch 来自 `browser.getState`。
 *
 * - **可见时，量不出一块非退化的矩形就别报。** 这不是洁癖：主进程的
 *   `applyViewport` 会拿 `bounds.width` 算 `scale = W / 1280`，宽度 0 会被
 *   `Math.max(1, …)` 兜成 1，于是 `scale ≈ 0.00078`、逻辑视口高度塌成 1px ——
 *   walker 的 `visible()` 会把整页元素全滤掉，agent 拿到一份空快照并判定
 *   「这个源是空页面」，全程无错误。宁可不报，让上一份几何继续有效。
 *
 * - **收起侧栏（visible=false）报的是「最后那一份真几何」，不是零矩形。** 理由同上：
 *   零矩形会把这个标签的逻辑视口毁掉，而 §B 明写浏览器的能力与侧栏可见性完全解耦。
 *   隐藏只该改「给人看的那一块在不在」，不该改页面按多宽渲染。
 *
 * - **从没报过就不必报「藏起来」。** 没告诉过主进程有这么一块舞台，也就没有什么要藏；
 *   而这一支正是唯一可能拿不到真几何的时候。
 *
 * - **与上一次逐字段相同就别报**（见 `sameReport`）。
 */
export function nextReport(args: {
  epoch: number;
  visible: boolean;
  occluded: boolean;
  /** 舞台元素这一刻的视口矩形；`null` = 没有元素可量。 */
  rect: { left: number; top: number; width: number; height: number } | null;
  last: StageReport | null;
}): StageReport | null {
  const { epoch, visible, occluded, rect, last } = args;
  if (epoch === NO_EPOCH) return null;

  let bounds: RectDip;
  if (visible) {
    if (rect === null) return null;
    const b = toStageBounds(rect);
    if (b.width <= 0 || b.height <= 0) return null;
    bounds = b;
  } else {
    if (last === null) return null;
    bounds = last.bounds;
  }

  const next: StageReport = { epoch, visible, occluded, bounds };
  return sameReport(last, next) ? null : next;
}
