import { describe, expect, it } from 'vitest';
import { fitCacheKey } from './TranslationBlocks';

const FONT = '400 12px "Noto Serif SC"';
const TEXT = '这是一段译文，长度与换行位置决定了字号能收到多少。';
const W = 460;
const H = 120;

// fitCache 是模块级 Map，同一渲染进程内对所有已打开的 PDF tab 共享（应用支持多个 tab 同时挂载，
// 见 uiStore.openFileTabs / MainPane 的「tab 打开期间始终挂载」）。
//
// key 要钉的不是「模板长什么样」，而是「决定 ratio 的那几个量有没有全在里面」：measureText、
// 块的 width/height、font。少了任何一维，换了输入却命中旧值，版面就永久错到重启为止。下面前
// 两条（不同译文 / 不同 bbox）正是原实现漏掉的那两维——它当时拿 block.id 当它们的身份代理。
describe('fitCacheKey', () => {
  it('同 id、同 font，target 变了 → key 必须不同（agent 重新翻译同一份 PDF 的主路径）', () => {
    const a = fitCacheKey('/a/paper.pdf', 'p1-b01', FONT, '旧的译文。', W, H);
    const b = fitCacheKey('/a/paper.pdf', 'p1-b01', FONT, '新的译文，比旧的长出不少内容。', W, H);
    expect(a).not.toBe(b);
  });

  it('同 id、同 font、同 target，bbox 变了 → key 必须不同', () => {
    const base = fitCacheKey('/a/paper.pdf', 'p1-b01', FONT, TEXT, W, H);
    expect(fitCacheKey('/a/paper.pdf', 'p1-b01', FONT, TEXT, W + 40, H)).not.toBe(base);
    expect(fitCacheKey('/a/paper.pdf', 'p1-b01', FONT, TEXT, W, H + 40)).not.toBe(base);
  });

  it('六项入参完全相同 → 同一个 key（缓存还得能命中，不然每次渲染都重量一遍）', () => {
    expect(fitCacheKey('/a/paper.pdf', 'p1-b01', FONT, TEXT, W, H))
      .toBe(fitCacheKey('/a/paper.pdf', 'p1-b01', FONT, TEXT, W, H));
  });

  it('block.id 相同，docKey 不同 → key 不同（block.id 按 spec 只保证文档内唯一）', () => {
    const a = fitCacheKey('/a/paper.pdf', 'p1-b01', FONT, TEXT, W, H);
    const b = fitCacheKey('/b/other.pdf', 'p1-b01', FONT, TEXT, W, H);
    expect(a).not.toBe(b);
  });

  it('docKey 相同，block.id 不同 → key 不同', () => {
    const a = fitCacheKey('/a/paper.pdf', 'p1-b01', FONT, TEXT, W, H);
    const b = fitCacheKey('/a/paper.pdf', 'p1-b02', FONT, TEXT, W, H);
    expect(a).not.toBe(b);
  });

  it('docKey、block.id 相同，font 不同 → key 不同', () => {
    const a = fitCacheKey('/a/paper.pdf', 'p1-b01', FONT, TEXT, W, H);
    const b = fitCacheKey('/a/paper.pdf', 'p1-b01', '600 14px "Noto Serif SC"', TEXT, W, H);
    expect(a).not.toBe(b);
  });

  // 拼串（`${a}|${b}|…`）的话，路径或译文里出现一个分隔符就能让两组不同的入参撞成同一个 key。
  // macOS 的文件名允许 `|`，译文更是任意文本。
  it('入参里带分隔符也不会把两组不同的输入撞成同一个 key', () => {
    const a = fitCacheKey('/a/x|y.pdf', 'b01', FONT, TEXT, W, H);
    const b = fitCacheKey('/a/x', 'y.pdf|b01', FONT, TEXT, W, H);
    expect(a).not.toBe(b);
  });
});
