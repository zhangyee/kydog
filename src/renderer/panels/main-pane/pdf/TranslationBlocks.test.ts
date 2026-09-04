import { describe, expect, it } from 'vitest';
import { beginFitRound, fitCacheDomain, fitCacheKey } from './TranslationBlocks';

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

// key 里含全文 measureText 与 bbox 之后，agent 每重译一次就是一整代全新的 key——旧代再也不会
// 被命中，只是永不释放的死数据。淘汰按精确集合差做：一趟测量把「读到的 + 新算的」记成新一代，
// commit 时整代替掉旧表，本轮没出现过的条目自然不在新表里。不是 LRU、不是 maxSize——那两样都是
// 阈值代理。
//
// 域是 (docKey, page)：TranslationBlocks 按页挂载，一趟只看得见一页的块，按 docKey 整代换会把
// 同一文档其余页的条目当成「本轮没出现」误删。
describe('fitCache 的代际淘汰', () => {
  const RATIO = { old: 0.8, keep: 0.9, fresh: 0.5, otherPage: 0.7, otherDoc: 0.6 };

  it('一轮跑完只留本轮出现过的条目，命中过的带进新一代', () => {
    const doc = '/evict/paper.pdf';
    const domain = fitCacheDomain(doc, 1);
    const kOld = fitCacheKey(doc, 'p1-b01', FONT, '第一代的译文。', W, H);
    const kNew = fitCacheKey(doc, 'p1-b01', FONT, '第二代的译文，比第一代长出不少内容。', W, H);
    const kKeep = fitCacheKey(doc, 'p1-b02', FONT, TEXT, W, H);

    const g1 = beginFitRound(domain);
    g1.set(kOld, RATIO.old);
    g1.set(kKeep, RATIO.keep);
    g1.commit();

    // 第二代：p1-b01 换了译文（新 key），p1-b02 的译文没变（命中旧值）
    const g2 = beginFitRound(domain);
    expect(g2.get(kKeep), '译文没变的块本轮该命中上一代').toBe(RATIO.keep);
    expect(g2.get(kNew), '换了译文就是新 key，不该命中').toBeUndefined();
    g2.set(kNew, RATIO.fresh);
    g2.commit();

    // 探针轮只读不 commit（它自己的新表随即丢弃，不会反过来影响缓存）
    const probe = beginFitRound(domain);
    expect(probe.get(kOld), '上一代里本轮没出现的条目必须被淘汰').toBeUndefined();
    expect(probe.get(kKeep), '本轮命中过的条目要带进新一代，不能跟着旧表一起没了').toBe(RATIO.keep);
    expect(probe.get(kNew)).toBe(RATIO.fresh);
  });

  // 单独一条，且**只 commit 受测的那一个域**：淘汰若按 docKey（甚至全表）做，红的会正好是
  // 「别的域不该被殃及」这两句，而不是被前面某句先绊倒。
  it('淘汰只作用于本域：同文档的其它页、另一个打开中的文档都不动', () => {
    const doc = '/evict/isolation.pdf';
    const other = '/evict/other.pdf';
    const kPage1 = fitCacheKey(doc, 'p1-b01', FONT, TEXT, W, H);
    const kPage2 = fitCacheKey(doc, 'p2-b01', FONT, TEXT, W, H);
    const kOtherDoc = fitCacheKey(other, 'p1-b01', FONT, TEXT, W, H);

    const p2 = beginFitRound(fitCacheDomain(doc, 2));
    p2.set(kPage2, RATIO.otherPage);
    p2.commit();
    const od = beginFitRound(fitCacheDomain(other, 1));
    od.set(kOtherDoc, RATIO.otherDoc);
    od.commit();

    // 第 1 页测量一趟并落地——它的新表里没有另外两个域的任何条目
    const p1 = beginFitRound(fitCacheDomain(doc, 1));
    p1.set(kPage1, RATIO.fresh);
    p1.commit();

    expect(beginFitRound(fitCacheDomain(doc, 2)).get(kPage2), '同文档的另一页不该被殃及')
      .toBe(RATIO.otherPage);
    expect(beginFitRound(fitCacheDomain(other, 1)).get(kOtherDoc), '另一个打开中的文档不该被殃及')
      .toBe(RATIO.otherDoc);
    expect(beginFitRound(fitCacheDomain(doc, 1)).get(kPage1)).toBe(RATIO.fresh);
  });

  it('中途作废的一轮不 commit，旧一代原样留着（不会被半代结果替掉）', () => {
    const doc = '/evict/aborted.pdf';
    const domain = fitCacheDomain(doc, 1);
    const kA = fitCacheKey(doc, 'p1-b01', FONT, TEXT, W, H);
    const kB = fitCacheKey(doc, 'p1-b02', FONT, TEXT, W, H);
    const g1 = beginFitRound(domain);
    g1.set(kA, RATIO.keep);
    g1.set(kB, RATIO.old);
    g1.commit();

    const aborted = beginFitRound(domain);
    aborted.set(kA, RATIO.fresh); // 量到一半就换了页/换了文档：不 commit

    const probe = beginFitRound(domain);
    expect(probe.get(kA), '没 commit 的一轮不该落地').toBe(RATIO.keep);
    expect(probe.get(kB), '没 commit 的一轮不该把上一代替掉').toBe(RATIO.old);
  });

  it('一页的块被整代删光 → 域跟着收掉，不留空表', () => {
    const doc = '/evict/emptied.pdf';
    const domain = fitCacheDomain(doc, 3);
    const k = fitCacheKey(doc, 'p3-b01', FONT, TEXT, W, H);
    const g1 = beginFitRound(domain);
    g1.set(k, RATIO.keep);
    g1.commit();
    beginFitRound(domain).commit(); // 新一代这一页一个带 target 的块都没有
    expect(beginFitRound(domain).get(k)).toBeUndefined();
  });
});
