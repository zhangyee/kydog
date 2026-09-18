import { describe, it, expect, vi } from 'vitest';
import { findOneWhere, mount, type FakeElement } from '../../../../test-support/miniReact';
import type { Block } from '../../../../shared/zhSidecar';

/**
 * **RightPage 真的按 coverRect 填盖子**（e2e/57「盖子按墨迹矩形」的接线那一半；几何本身在
 * blockRect.test.ts）。
 *
 * 真挂载一遍（miniReact），把合成用的两块 2D 上下文换成记账的替身：左格那块只回答八点取样
 * （全白 → 取得到页背景），右格那块记下每一次 fillRect。断言的是填了哪几个矩形。
 *
 * 守不住的：真画布上的像素（抗锯齿、drawImage 到底拷没拷对）——那只有 e2e 看得见。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { RightPage } = await import('./RightPage');
const { coverRect } = await import('./blockRect');

const SIZE = { w: 595, h: 842 };
const BASELINE = 400;
/** 一行带降部的字，边车里写了墨迹框（原 e2e/57 的 DESC_BLOCK，那条 e2e 已并进这里的单测）。 */
const DESC: Block = {
  id: 'desc', page: 1, x: 78, y: BASELINE - 14, width: 120, height: 14, fontSize: 14, kind: 'text',
  source: 'gypq gypq gypq', target: '降部', ink: { top: BASELINE - 0.718 * 14, bottom: BASELINE + 0.207 * 14 },
};
/** 不翻译的块（没有 target）：公式、表格这类，右格原样留着。 */
const FORMULA: Block = { id: 'eq', page: 1, x: 60, y: 500, width: 200, height: 40, fontSize: 11, kind: 'formula', source: 'E = mc^2' };

describe('RightPage：盖子按 coverRect 填', () => {
  it('有 target 的块填 coverRect(b, S)（带 ink 的口径）；没有 target 的块不盖', () => {
    const fills: number[][] = [];
    const ctx = { fillStyle: '', drawImage: () => {}, fillRect: (...a: number[]) => { fills.push(a); } };
    // 位图是 2× 的：S = 1190 / 595 = 2
    const left = { width: SIZE.w * 2, height: SIZE.h * 2, getContext: () => ({ getImageData: () => ({ data: [255, 255, 255, 255] }) }) };

    const props = { size: SIZE, rasterScale: 1, blocks: [DESC, FORMULA], leftCanvas: null as HTMLCanvasElement | null };
    const m = mount(RightPage, props);
    // 左格还没画好（leftCanvas = null）时 effect 早退，不碰右格的 getContext；趁这时给假元素装上。
    const el = (findOneWhere(m.tree, (n) => n.type === 'canvas').props.ref as { current: FakeElement }).current;
    Object.assign(el, { getContext: () => ctx });
    expect(fills).toEqual([]);

    m.rerender({ ...props, leftCanvas: left as unknown as HTMLCanvasElement });
    const r = coverRect(DESC, 2);
    expect(fills).toEqual([[r.x, r.y, r.w, r.h]]);

    // 夹具里的 ink 确实改变了答案：按字身框算的盖子是另一个矩形（退回老口径就会红在上一条）。
    const glyph = coverRect({ ...DESC, ink: undefined }, 2);
    expect([glyph.x, glyph.y, glyph.w, glyph.h]).not.toEqual(fills[0]);
  });
});
