/**
 * 右栏那块地归谁、多宽、收没收起。
 *
 * 浏览器侧栏与 Inspector **共用右栏**，同一时刻只有一个在。挑哪个组件、用哪一份宽度、
 * 收起状态按谁的，必须是**同一个判断** —— 分散在组件里的话，「浏览器开着却按
 * Inspector 的宽度排版」是一个编译得过、也不会有任何用例红的状态（第二轮变异 N12
 * 实测三条 gate 全绿）。
 */

export type RightPaneState = {
  browserOpen: boolean;
  browserWidth: number;
  inspectorCollapsed: boolean;
  inspectorWidth: number;
};

export type RightPaneLayout = {
  mode: 'browser' | 'inspector';
  width: number;
  collapsed: boolean;
};

export function rightPaneLayout(s: RightPaneState): RightPaneLayout {
  // 浏览器侧栏没有「收起成一条竖轨」那一档 —— 收起就是关掉（标题栏那个地球，
  // 或者侧栏头上那个按钮）。**`inspectorCollapsed` 不跟着改**：关掉浏览器时
  // Inspector 要回到用户上次留下的样子，而不是被浏览器的开关掰了一下。
  if (s.browserOpen) return { mode: 'browser', width: s.browserWidth, collapsed: false };
  return { mode: 'inspector', width: s.inspectorWidth, collapsed: s.inspectorCollapsed };
}
