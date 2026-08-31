// src/main/windowChrome.test.ts
import { describe, it, expect } from 'vitest';
import { windowChrome } from './windowChrome';

describe('windowChrome', () => {
  it('darwin → hiddenInset，不设 overlay，不碰菜单栏', () => {
    expect(windowChrome('darwin')).toEqual({ titleBarStyle: 'hiddenInset' });
  });
  it('win32 → hidden + overlay 高度对齐 TitleBar 的 h-9，且不设 autoHideMenuBar', () => {
    // autoHideMenuBar 在这里是死配置：hidden 拿掉了承载菜单栏的原生边框，
    // 菜单栏就再也画不出来。实测（Electron 41 / win32）关掉 autoHideMenuBar 并显式
    // setMenuBarVisibility(true) 之后，isMenuBarVisible() 仍为 false、web contents
    // 高度纹丝不动。留着它只会让人以为 Alt 能唤出菜单。
    expect(windowChrome('win32')).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { height: 36 },
    });
  });
  it('linux → 保留原生边框，菜单栏在那里是真能收起的', () => {
    // hidden 而不给 titleBarOverlay 会让 Linux 既没有原生边框也没有窗口按钮，
    // 等于关不掉窗口。overlay 我们只给 win32，所以 Linux 维持 default —— 边框还在，
    // 菜单栏也就有地方画，autoHideMenuBar 在这条分支上是有意义的。
    expect(windowChrome('linux')).toEqual({ titleBarStyle: 'default', autoHideMenuBar: true });
  });
});
