import { describe, it, expect } from 'vitest';
import { inputStyle } from './ui';

/**
 * 守一条看不出所以然、极易被「顺手统一成 `7px 0`」改回去的规则。
 *
 * 文本输入框的左内边距不能是 0：空值时插入点正落在内容盒最左那一列，被文本控件内层的
 * 滚动容器裁掉。表现是聚焦后只有 focus ring、没有光标，打进第一个字符光标右移了才露出来。
 * 在浏览器里逐项对照过（placeholder / 边框 / 背景都不是变量，唯一变量是 padding-left）。
 */
describe('inputStyle', () => {
  it('左内边距不为 0，否则空输入框看不到光标', () => {
    const padding = String(inputStyle.padding ?? '');
    const parts = padding.trim().split(/\s+/);
    // CSS 简写：1 值 → 四边；2 值 → 上下/左右；3 值 → 上/左右/下；4 值 → 上右下左。
    const left = parts.length === 4 ? parts[3] : parts.length === 1 ? parts[0] : parts[1];
    expect(left).toBeDefined();
    expect(parseFloat(left)).toBeGreaterThan(0);
  });
});
