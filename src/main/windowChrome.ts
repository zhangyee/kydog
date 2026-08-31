// src/main/windowChrome.ts
import type { BrowserWindowConstructorOptions } from 'electron';

export type WindowChrome = Pick<
  BrowserWindowConstructorOptions,
  'titleBarStyle' | 'titleBarOverlay' | 'autoHideMenuBar'
>;

/** 必须与 TitleBar 的 h-9（2.25rem = 36px）一致：overlay 覆盖的是同一条带子，
 *  两边对不上会让窗口按钮浮在标题栏外面。 */
export const TITLE_BAR_HEIGHT = 36;

/** 窗口边框与菜单栏的平台差异集中在这里。
 *
 *  darwin：hiddenInset 隐掉边框、保留左上角三个原生按钮，TitleBar 靠 paddingLeft 给它们让位。
 *
 *  win32： hidden 去掉边框，titleBarOverlay 把三个按钮以叠加层画到右上角。overlay 的颜色
 *          **不在这里给** —— 主题色的真源是渲染层的 theme CSS，窗口创建时渲染进程还没起来，
 *          由 ThemeApplier 随后经 RPC 补上。
 *
 *          这里**故意不设 autoHideMenuBar**：hidden 拿掉了承载菜单栏的原生边框，菜单栏就
 *          再也画不出来，那个选项在这条分支上完全没有作用。实测（Electron 41 / win32）把
 *          autoHideMenuBar 置 false 再显式 setMenuBarVisibility(true)，isMenuBarVisible()
 *          仍为 false、web contents 高度一动不动。设上它只会让人误以为 Alt 能唤出菜单。
 *          win32 的应用菜单因此只剩一个作用：提供 Ctrl+C/V/A/Z、Ctrl+R、Ctrl+Shift+I 这些
 *          加速键（见 menu.ts）—— 加速键不依赖菜单栏渲染，照常生效。
 *
 *  其余（linux）：维持 default。hidden 而不配 overlay 会连窗口按钮一起没有，而 overlay 我们
 *          只给 win32。边框留着，菜单栏就有地方画，autoHideMenuBar 在这条分支上是真生效的。 */
export function windowChrome(platform: NodeJS.Platform): WindowChrome {
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  if (platform === 'win32') {
    return { titleBarStyle: 'hidden', titleBarOverlay: { height: TITLE_BAR_HEIGHT } };
  }
  return { titleBarStyle: 'default', autoHideMenuBar: true };
}
