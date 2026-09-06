import { describe, expect, it } from 'vitest';
import { THUMB_MIN_PX, scrollPosForThumb, thumbGeometry } from './overlayScrollbar';

describe('thumbGeometry', () => {
  it('内容不比视口高 → null（不渲染这一条）', () => {
    expect(thumbGeometry({ clientLen: 500, scrollLen: 500, scrollPos: 0, trackLen: 496 })).toBeNull();
    expect(thumbGeometry({ clientLen: 500, scrollLen: 300, scrollPos: 0, trackLen: 496 })).toBeNull();
  });

  it('长度 = 视口 / 内容 × 轨道', () => {
    const t = thumbGeometry({ clientLen: 500, scrollLen: 2000, scrollPos: 0, trackLen: 400 })!;
    expect(t.len).toBeCloseTo(100, 6);
    expect(t.pos).toBe(0);
  });

  it('长度不小于 THUMB_MIN_PX', () => {
    const t = thumbGeometry({ clientLen: 500, scrollLen: 500_000, scrollPos: 0, trackLen: 400 })!;
    expect(t.len).toBe(THUMB_MIN_PX);
  });

  it('滚到底 → 拇指贴住轨道末端；中点 → 轨道中点', () => {
    const base = { clientLen: 500, scrollLen: 2000, trackLen: 400 };
    const end = thumbGeometry({ ...base, scrollPos: 1500 })!;
    expect(end.pos).toBeCloseTo(400 - end.len, 6);
    const mid = thumbGeometry({ ...base, scrollPos: 750 })!;
    expect(mid.pos).toBeCloseTo((400 - mid.len) / 2, 6);
  });

  it('scrollPos 越界时钳在两端', () => {
    const base = { clientLen: 500, scrollLen: 2000, trackLen: 400 };
    expect(thumbGeometry({ ...base, scrollPos: -50 })!.pos).toBe(0);
    const over = thumbGeometry({ ...base, scrollPos: 99_999 })!;
    expect(over.pos).toBeCloseTo(400 - over.len, 6);
  });

  it('轨道比 THUMB_MIN_PX 还短 → 长度钳到轨道全长、range 归零、拇指贴死在起点', () => {
    // trackLen(10) < THUMB_MIN_PX(24)：len 想取 24 但 Math.min(trackLen, …) 把它按到 10；
    // range = trackLen − len = 0，拖拽范围为零，拇指不管 scrollPos 是多少都钉在 0。
    const t = thumbGeometry({ clientLen: 20, scrollLen: 200, scrollPos: 90, trackLen: 10 })!;
    expect(t.len).toBe(10);
    expect(t.pos).toBe(0);
  });
});

describe('scrollPosForThumb', () => {
  const base = { clientLen: 500, scrollLen: 2000, trackLen: 400 };

  it('与 thumbGeometry 互逆', () => {
    for (const scrollPos of [0, 1, 250, 749.5, 1500]) {
      const t = thumbGeometry({ ...base, scrollPos })!;
      expect(scrollPosForThumb(base, t.pos)).toBeCloseTo(scrollPos, 6);
    }
  });

  it('拇指位置越界时钳在 [0, scrollLen − clientLen]', () => {
    expect(scrollPosForThumb(base, -100)).toBe(0);
    expect(scrollPosForThumb(base, 10_000)).toBe(1500);
  });

  it('不能滚 → 0', () => {
    expect(scrollPosForThumb({ clientLen: 500, scrollLen: 500, trackLen: 400 }, 30)).toBe(0);
  });

  it('轨道比 THUMB_MIN_PX 还短 → range 为零，反算恒为 0', () => {
    expect(scrollPosForThumb({ clientLen: 20, scrollLen: 200, trackLen: 10 }, 5)).toBe(0);
  });
});
