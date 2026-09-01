// src/main/menu.ts
import { Menu, type MenuItemConstructorOptions } from 'electron';

/** null = 沿用 Electron 默认菜单。
 *
 *  darwin 必须沿用：mac 的菜单挂在系统菜单栏里，本来就不占窗口空间，而 Cmd+Q / Cmd+C /
 *  Cmd+W 这些快捷键全部由默认模板的 role 提供，换成精简模板会连快捷键一起丢掉。
 *
 *  win32 / linux 换成精简模板，只留两组 role：editMenu 提供 Ctrl+X/C/V/A/Z/Y，
 *  viewMenu 提供 Ctrl+R、Ctrl+Shift+R、Ctrl+Shift+I 与缩放/全屏。
 *  （F12 不在其中 —— Electron 的 toggleDevTools role 在非 mac 平台绑的是 Ctrl+Shift+I，
 *   见 lib/browser/api/menu-item-roles.ts，F12 从未被绑定过。）
 *
 *  两个平台上这个模板的**可见性完全不同**，别把 win32 的行为推广到 linux：
 *  - win32 走 titleBarStyle:'hidden'（见 windowChrome.ts），原生边框没了，菜单栏无处可画，
 *    实测用任何手段都叫不出来。菜单在那里只剩一个作用 —— 提供上面那些加速键，
 *    加速键不依赖菜单栏渲染，照常生效。
 *  - linux 保留 default 边框，菜单栏能画出来，由 autoHideMenuBar 收起、按 Alt 浮出。 */
export function menuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
  if (platform === 'darwin') return null;
  return [{ role: 'editMenu' }, { role: 'viewMenu' }];
}

export function installAppMenu(platform: NodeJS.Platform = process.platform): void {
  const template = menuTemplate(platform);
  if (template) Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
