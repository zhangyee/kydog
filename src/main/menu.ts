// src/main/menu.ts
import { Menu, type BaseWindow, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import { broadcaster } from './ipc/broadcaster';

type CloseActiveTab = (win: BaseWindow) => void;

function emitCloseActiveTab(win: BaseWindow): void {
  // Electron 的 Menu click 签名统一给 BaseWindow；本应用可聚焦的可见窗口只有 BrowserWindow。
  const browserWindow = win as BrowserWindow;
  broadcaster.emitTo(browserWindow.webContents, 'ui.closeActiveTab', undefined);
}

/**
 * darwin 也装显式模板：默认 File 菜单里的 Cmd+W 是 close role，会直接关 BrowserWindow，
 * 绕过渲染层的活动 tab 与未保存确认。自定义 Close Tab 把意图送回焦点窗口；appMenu 继续
 * 提供 Cmd+Q，edit/view/windowMenu 继续提供系统惯用角色。
 *
 *  win32 / linux 换成精简模板，只留两组 role：editMenu 提供 Ctrl+X/C/V/A/Z/Y，
 *  viewMenu 提供 Ctrl+R、Ctrl+Shift+R、Ctrl+Shift+I 与缩放/全屏；再加一个不可缺的
 *  Close Tab（Ctrl+W）。
 *  （F12 不在其中 —— Electron 的 toggleDevTools role 在非 mac 平台绑的是 Ctrl+Shift+I，
 *   见 lib/browser/api/menu-item-roles.ts，F12 从未被绑定过。）
 *
 *  两个平台上这个模板的**可见性完全不同**，别把 win32 的行为推广到 linux：
 *  - win32 走 titleBarStyle:'hidden'（见 windowChrome.ts），原生边框没了，菜单栏无处可画，
 *    实测用任何手段都叫不出来。菜单在那里只剩一个作用 —— 提供上面那些加速键，
 *    加速键不依赖菜单栏渲染，照常生效。
 *  - linux 保留 default 边框，菜单栏能画出来，由 autoHideMenuBar 收起、按 Alt 浮出。 */
export function menuTemplate(
  platform: NodeJS.Platform,
  closeActiveTab: CloseActiveTab = emitCloseActiveTab,
): MenuItemConstructorOptions[] {
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [{
      label: 'Close Tab',
      accelerator: 'CommandOrControl+W',
      click: (_item, focusedWindow) => {
        if (focusedWindow) closeActiveTab(focusedWindow);
      },
    }],
  };
  if (platform === 'darwin') {
    return [
      { role: 'appMenu' }, fileMenu, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    ];
  }
  return [fileMenu, { role: 'editMenu' }, { role: 'viewMenu' }];
}

export function installAppMenu(platform: NodeJS.Platform = process.platform): void {
  const template = menuTemplate(platform);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
