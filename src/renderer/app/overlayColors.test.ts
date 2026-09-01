// src/renderer/app/overlayColors.test.ts
import { describe, it, expect } from 'vitest';
import { overlayColors } from './overlayColors';

// 主题 CSS 里这两个 token 是 oklch()，Electron 的颜色解析器不认，必须先归一化成 #rrggbb。
const vellum: Record<string, string> = {
  '--color-titlebar-bg-to': 'oklch(0.975 0.010 82)',
  '--color-titlebar-text': 'oklch(0.42 0.018 55)',
};
const hex: Record<string, string> = {
  'oklch(0.975 0.010 82)': '#f9f6ef',
  'oklch(0.42 0.018 55)': '#5f5449',
};
const toHex = (css: string) => hex[css] ?? '';

describe('overlayColors', () => {
  it('底色取 bg-to、符号色取 text，两者都过归一化', () => {
    expect(overlayColors((n) => vellum[n] ?? '', toHex)).toEqual({
      color: '#f9f6ef',
      symbolColor: '#5f5449',
    });
  });
  it('token 读不到 → null（主题 CSS 还没生效，不该拿默认黑去刷窗口按钮）', () => {
    expect(overlayColors(() => '', toHex)).toBeNull();
  });
  it('只缺一个 token → 同样 null', () => {
    const partial: Record<string, string> = { ...vellum, '--color-titlebar-text': '' };
    expect(overlayColors((n) => partial[n] ?? '', toHex)).toBeNull();
  });
  it('token 有值但归一化失败 → null（不发半截载荷）', () => {
    expect(overlayColors((n) => vellum[n] ?? '', () => '')).toBeNull();
  });
});
