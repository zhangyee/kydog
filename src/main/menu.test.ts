// src/main/menu.test.ts
import { describe, it, expect, vi } from 'vitest';
import { menuTemplate } from './menu';

// menu.ts 在 installAppMenu 里运行期用到 Menu；只测纯函数，替身一个空壳即可。
vi.mock('electron', () => ({ Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() } }));

describe('menuTemplate', () => {
  it('darwin → null（沿用 Electron 默认菜单，Cmd+Q / Cmd+C 全靠它的 role）', () => {
    expect(menuTemplate('darwin')).toBeNull();
  });
  it('win32 → 只留 editMenu 与 viewMenu', () => {
    expect(menuTemplate('win32')).toEqual([{ role: 'editMenu' }, { role: 'viewMenu' }]);
  });
  it('linux → 与 win32 相同', () => {
    expect(menuTemplate('linux')).toEqual([{ role: 'editMenu' }, { role: 'viewMenu' }]);
  });
});
