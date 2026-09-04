import { describe, expect, it } from 'vitest';
import { fitCacheKey } from './TranslationBlocks';

// fitCache 是模块级 Map，同一渲染进程内对所有已打开的 PDF tab 共享（应用支持多个 tab 同时挂载，
// 见 uiStore.openFileTabs / MainPane 的「tab 打开期间始终挂载」）。block.id 按 spec 只保证
// 「文档内」唯一，两篇不同论文完全可能都用 `p1-b01` 这样的顺序化 id；不带 docKey 的话，两个 tab
// 会在同一个 key 上互相覆写对方算出的 fontScale。这个测试钉住 key 的构造本身带上了 docKey 这一维。
describe('fitCacheKey', () => {
  it('同一 docKey、同一 block、同一 font → 同一个 key（缓存能命中）', () => {
    expect(fitCacheKey('/a/paper.pdf', 'p1-b01', '400 12px "Noto Serif SC"'))
      .toBe(fitCacheKey('/a/paper.pdf', 'p1-b01', '400 12px "Noto Serif SC"'));
  });

  it('block.id 相同，docKey 不同 → key 不同', () => {
    const a = fitCacheKey('/a/paper.pdf', 'p1-b01', '400 12px "Noto Serif SC"');
    const b = fitCacheKey('/b/other.pdf', 'p1-b01', '400 12px "Noto Serif SC"');
    expect(a).not.toBe(b);
  });

  it('docKey 相同，block.id 不同 → key 不同', () => {
    const a = fitCacheKey('/a/paper.pdf', 'p1-b01', '400 12px "Noto Serif SC"');
    const b = fitCacheKey('/a/paper.pdf', 'p1-b02', '400 12px "Noto Serif SC"');
    expect(a).not.toBe(b);
  });

  it('docKey、block.id 相同，font 不同 → key 不同', () => {
    const a = fitCacheKey('/a/paper.pdf', 'p1-b01', '400 12px "Noto Serif SC"');
    const b = fitCacheKey('/a/paper.pdf', 'p1-b01', '600 14px "Noto Serif SC"');
    expect(a).not.toBe(b);
  });
});
