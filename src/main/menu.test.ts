// src/main/menu.test.ts
import { describe, it, expect, vi } from 'vitest';
import { menuTemplate } from './menu';

// menu.ts 在 installAppMenu 里运行期用到 Menu；只测纯函数，替身一个空壳即可。
vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() } }));

describe('menuTemplate', () => {
  function closeItem(platform: NodeJS.Platform, onClose = vi.fn()) {
    const template = menuTemplate(platform, onClose);
    const file = template.find((item) => item.label === 'File');
    if (!file || !Array.isArray(file.submenu)) throw new Error(`${platform} 没有 File 菜单`);
    const close = file.submenu.find((item) => 'label' in item && item.label === 'Close Tab');
    if (!close || typeof close === 'string') throw new Error(`${platform} 没有 Close Tab`);
    return { template, close, onClose };
  }

  it('darwin 保留原生 app/edit/view/window 菜单，并用 CommandOrControl+W 关闭当前 tab', () => {
    const { template, close } = closeItem('darwin');
    expect(template.map((item) => item.role ?? item.label)).toEqual([
      'appMenu', 'File', 'editMenu', 'viewMenu', 'windowMenu',
    ]);
    expect(close.accelerator).toBe('CommandOrControl+W');
  });

  it.each(['win32', 'linux'] as const)('%s 保留 edit/view 菜单，并用 CommandOrControl+W 关闭当前 tab', (platform) => {
    const { template, close } = closeItem(platform);
    expect(template.map((item) => item.role ?? item.label)).toEqual(['File', 'editMenu', 'viewMenu']);
    expect(close.accelerator).toBe('CommandOrControl+W');
  });

  it('Close Tab 只把 Electron 交来的 focusedWindow 传给关闭出口；没有焦点窗口时不发', () => {
    const { close, onClose } = closeItem('darwin');
    const focused = { id: 7 };
    const other = { id: 8 };
    const click = close.click;
    if (typeof click !== 'function') throw new Error('Close Tab 没有 click handler');

    click({} as never, focused as never, {} as never);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(focused);
    expect(onClose).not.toHaveBeenCalledWith(other);

    click({} as never, undefined, {} as never);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
