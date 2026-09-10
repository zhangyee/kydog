import { MIN_BROWSER_WIDTH } from '../../shared/types';

/** 对话栏最小宽。**它压过 4:6** —— 见 `browserWidthFor`。 */
export const MIN_MAIN_WIDTH = 360;
/** 没设定过时浏览器占可用宽度的比例（对话:浏览器 = 4:6）。 */
export const BROWSER_SHARE = 0.6;

export type RightPaneState = {
  browserOpen: boolean;
  /** 用户设定过的宽度；`null` = 从没拖过，按 4:6 算。 */
  browserWidth: number | null;
  browserFullscreen: boolean;
  inspectorCollapsed: boolean;
  inspectorWidth: number;
  /** 中栏 + 右栏可用的总宽（容器宽减左栏与把手），由 `availableForCenterAndRight` 算。 */
  availableWidth: number;
};

export type RightPaneLayout = {
  mode: 'browser' | 'inspector';
  width: number;
  collapsed: boolean;
  /** 全屏时为真：中栏那一格 `0px`、右栏吃 `1fr`。 */
  centerHidden: boolean;
};

/** 容器宽 → 中栏与右栏能分的那一段。左栏收起时是 24px 的轨，且没有那个拖拽把手。 */
export function availableForCenterAndRight(
  containerWidth: number, workspaceCollapsed: boolean, workspaceWidth: number,
): number {
  const left = workspaceCollapsed ? 24 : workspaceWidth;
  const leftHandle = workspaceCollapsed ? 0 : 4;
  const rightHandle = 4;
  return Math.max(0, containerWidth - left - leftHandle - rightHandle);
}

/**
 * 浏览器该多宽。**三条规则有先后，顺序不能换：**
 *
 * 1. 没设定过就按 4:6 算一个候选；设定过就用记住的那个。
 * 2. **下限压过 4:6** —— 对话栏不够 `MIN_MAIN_WIDTH` 就压浏览器。1024 窗口下 4:6
 *    本身就给对话栏 306（低于 360），不压的话就是「窗口把 composer 挤没」那个坑。
 *    记住的宽度**一样要被压**，否则用户在宽窗口拖宽之后换到窄屏就复现同一个坑。
 * 3. 两个下限都放不下时按**下限自己的比例**缩。不按 4:6 缩：那样在 680 这个边界上
 *    会跳变（680 给 320、679 给 407，窗口窄 1px 浏览器反而暴涨），而按下限比例是连续的。
 */
export function browserWidthFor(saved: number | null, available: number): number {
  const floorSum = MIN_MAIN_WIDTH + MIN_BROWSER_WIDTH;
  if (available < floorSum) {
    return Math.max(1, Math.round(available * (MIN_BROWSER_WIDTH / floorSum)));
  }
  const want = saved ?? Math.round(available * BROWSER_SHARE);
  return Math.max(MIN_BROWSER_WIDTH, Math.min(want, available - MIN_MAIN_WIDTH));
}

/**
 * 右栏那块地归谁、多宽、收没收起、中栏藏没藏。
 *
 * 浏览器侧栏与 Inspector **共用右栏**，同一时刻只有一个在。这四件事必须是**同一个判断**
 * —— 分散在组件里的话，「浏览器开着却按 Inspector 的宽度排版」是一个编译得过、
 * 也不会有任何用例红的状态（第二轮变异 N12 实测三条 gate 全绿）。宽度钳制与全屏同理：
 * 写在组件里就没有用例守得住它们。
 */
export function rightPaneLayout(s: RightPaneState): RightPaneLayout {
  // 浏览器侧栏没有「收起成一条竖轨」那一档 —— 收起就是关掉。
  // **`inspectorCollapsed` 不跟着改**：关掉浏览器时 Inspector 要回到用户上次留下的样子。
  if (!s.browserOpen) {
    return {
      mode: 'inspector', width: s.inspectorWidth,
      collapsed: s.inspectorCollapsed, centerHidden: false,
    };
  }
  if (s.browserFullscreen) {
    return { mode: 'browser', width: s.availableWidth, collapsed: false, centerHidden: true };
  }
  return {
    mode: 'browser', width: browserWidthFor(s.browserWidth, s.availableWidth),
    collapsed: false, centerHidden: false,
  };
}
