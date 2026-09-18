import { describe, it, expect } from 'vitest';
import { BLOCK_PAD, containsCenter, coverRect, paddedRect, unionRect } from './blockRect';

describe('blockRect', () => {
  it('paddedRect 四周各外扩 BLOCK_PAD', () => {
    expect(paddedRect({ x: 10, y: 20, w: 100, h: 50 }))
      .toEqual({ x: 10 - BLOCK_PAD, y: 20 - BLOCK_PAD, w: 100 + 2 * BLOCK_PAD, h: 50 + 2 * BLOCK_PAD });
  });
  it('unionRect 取并集', () => {
    expect(unionRect([{ x: 10, y: 10, w: 20, h: 10 }, { x: 40, y: 30, w: 10, h: 10 }]))
      .toEqual({ x: 10, y: 10, w: 40, h: 30 });
  });
  it('unionRect 单个矩形原样返回', () => {
    expect(unionRect([{ x: 1, y: 2, w: 3, h: 4 }])).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
  it('unionRect 空数组抛错，不产出 Infinity 垃圾矩形', () => {
    // 去掉那道 guard 时这里会拿到 {x: Infinity, y: Infinity, w: -Infinity, h: -Infinity}
    // 而不是抛——断言「抛」正是为了把那条静默路径钉死。
    expect(() => unionRect([])).toThrow(/空的矩形数组/);
  });
  it('containsCenter 看的是中心点不是相交', () => {
    const r = { x: 0, y: 0, w: 100, h: 10 };
    // 与 r 相交但中心在外 → false（相邻两行字身框沾边的情形，不该被判死）
    expect(containsCenter(r, { x: 0, y: 8, w: 100, h: 10 })).toBe(false);
    // 中心在内 → true
    expect(containsCenter(r, { x: 0, y: 2, w: 100, h: 4 })).toBe(true);
  });
});

/**
 * 右格盖子（原先由 e2e/57「盖子按墨迹矩形——最后一行的降部不再从块底漏出来」在真画布上取样守着）。
 *
 * 夹具照抄那条 e2e：一行 14 pt 的 'gypq gypq gypq'，基线在 y = 400；字身框是「基线 − 字高 → 基线」，
 * 墨迹框按 pdf.js 的 ascent / descent（0.718 / 0.207）算。取样带是基线下 1.5–3 pt——老盖子（按字身框）
 * 的下沿到降部尖之间，g / y / p / q 的尾巴就落在这里。
 */
describe('coverRect：右格盖子按墨迹矩形', () => {
  const BASELINE = 400;
  const GLYPH = { x: 78, y: BASELINE - 14, width: 120, height: 14 };                       // 字身框
  const INK = { top: BASELINE - 0.718 * 14, bottom: BASELINE + 0.207 * 14 };              // 墨迹框
  const BAND = { x0: 80, x1: 78 + 120 - 2, y0: BASELINE + 1.5, y1: BASELINE + 3 };         // 降部那条带

  const covers = (r: { x: number; y: number; w: number; h: number }, S: number) =>
    r.x <= BAND.x0 * S && r.x + r.w >= BAND.x1 * S && r.y <= BAND.y0 * S && r.y + r.h >= BAND.y1 * S;

  // 1 = 1× 屏满缩放；2 = 2× 屏；0.78 = 对照里那种 rasterScale 0.39 × dpr 2 的小位图（取整误差最显眼）。
  it.each([1, 2, 0.78])('有 ink：盖子从 ink.top − PAD 起、盖过 ink.bottom，降部那条带在里面（S = %s）', (S) => {
    const r = coverRect({ ...GLYPH, ink: INK }, S);
    expect(r.y).toBe(Math.floor((INK.top - BLOCK_PAD) * S));
    // 远端那条边是 floor(起点) + ceil(尺寸)，不保证够到 ink.bottom + PAD（S = 1 时 404 < 404.398，
    // 外扩那一截最多被削掉不到 1 px），所以这里只断言墨迹本身被盖过——这是那条 e2e 要的事实。
    expect(r.y + r.h).toBeGreaterThanOrEqual(INK.bottom * S);
    expect(covers(r, S)).toBe(true);

    // 同一块去掉 ink（老边车）就盖不住这条带——证明上面那条成立靠的是 ink，不是外扩或取整碰巧够到。
    expect(covers(coverRect(GLYPH, S), S)).toBe(false);
  });

  it('没有 ink（老边车）：退回字身框，四周外扩 BLOCK_PAD，起点 floor、尺寸 ceil', () => {
    expect(BLOCK_PAD).toBe(1.5);   // 下面的字面值按 1.5 算
    // S = 1：76.5 → 76、384.5 → 384；宽 120 + 3、高 14 + 3 本来就是整数
    expect(coverRect(GLYPH, 1)).toEqual({ x: 76, y: 384, w: 123, h: 17 });
    // S = 0.78：59.67 → 59、299.91 → 299、95.94 → 96、13.26 → 14（向外取整，边缘不留半像素）
    expect(coverRect(GLYPH, 0.78)).toEqual({ x: 59, y: 299, w: 96, h: 14 });
  });
});
