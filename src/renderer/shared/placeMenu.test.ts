import { describe, it, expect } from 'vitest';
import { placeMenu } from './placeMenu';

const VP = { width: 1000, height: 700 };
const SIZE = { width: 200, height: 120 };

describe('placeMenu', () => {
  it('放得下：原样贴在指针处', () => {
    expect(placeMenu({ x: 100, y: 100 }, SIZE, VP)).toEqual({ left: 100, top: 100 });
  });

  it('刚好贴到边距线：不动', () => {
    expect(placeMenu({ x: 792, y: 572 }, SIZE, VP)).toEqual({ left: 792, top: 572 });
  });

  it('右边放不下：往左挪到贴着边距', () => {
    expect(placeMenu({ x: 900, y: 100 }, SIZE, VP)).toEqual({ left: 792, top: 100 });
  });

  it('下边放不下：整个翻到指针上方', () => {
    expect(placeMenu({ x: 100, y: 650 }, SIZE, VP)).toEqual({ left: 100, top: 530 });
  });

  it('右、下都放不下：两条同时生效', () => {
    expect(placeMenu({ x: 950, y: 690 }, SIZE, VP)).toEqual({ left: 792, top: 570 });
  });
});
