import { describe, expect, it } from 'vitest';
import { unitLayout } from './pageLayout';

describe('unitLayout', () => {
  it('空文档', () => {
    expect(unitLayout([], 16, 24)).toEqual({ tops: [], total: 48 });
  });

  it('单页：上下各一份留白，没有页间距', () => {
    expect(unitLayout([{ w: 595, h: 842 }], 16, 24)).toEqual({ tops: [24], total: 890 });
  });

  it('三页等高：每页多一个 gap', () => {
    const r = unitLayout([{ w: 595, h: 800 }, { w: 595, h: 800 }, { w: 595, h: 800 }], 16, 24);
    expect(r.tops).toEqual([24, 840, 1656]);
    expect(r.total).toBe(24 + 800 * 3 + 16 * 2 + 24);
  });

  it('页高不等时逐页累加，不用平均值', () => {
    const r = unitLayout([{ w: 595, h: 100 }, { w: 595, h: 900 }, { w: 595, h: 200 }], 10, 0);
    expect(r.tops).toEqual([0, 110, 1020]);
    expect(r.total).toBe(1220);
  });
});
