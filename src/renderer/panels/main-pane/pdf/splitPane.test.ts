import { describe, it, expect } from 'vitest';
import { clampSplit, DIVIDER_PX, fitToNarrower, MIN_PANE_PX, paneWidths } from './splitPane';

describe('clampSplit', () => {
  const W = 1000, L = 100;                    // wrapper 从 x=100 起、宽 1000
  it('指针在中间 → 0.5', () => {
    expect(clampSplit(L + (W - DIVIDER_PX) / 2, L, W)).toBeCloseTo(0.5, 6);
  });
  it('拖过左下限 → 左栏钉在 MIN_PANE_PX', () => {
    const r = clampSplit(L + 10, L, W);
    expect(paneWidths(W, r).left).toBeCloseTo(MIN_PANE_PX, 6);
  });
  it('拖过右下限 → 右栏钉在 MIN_PANE_PX', () => {
    const r = clampSplit(L + W - 10, L, W);
    expect(paneWidths(W, r).right).toBeCloseTo(MIN_PANE_PX, 6);
  });
  it('wrapper 窄到放不下两个最小栏 → 钉在 0.5', () => {
    expect(clampSplit(0, 0, 2 * MIN_PANE_PX + DIVIDER_PX - 1)).toBe(0.5);
  });
});

describe('paneWidths', () => {
  it('左右加分隔线等于 wrapper 宽', () => {
    const { left, right } = paneWidths(1000, 0.3);
    expect(left + right + DIVIDER_PX).toBeCloseTo(1000, 6);
    expect(left).toBeCloseTo((1000 - DIVIDER_PX) * 0.3, 6);
  });
});

describe('fitToNarrower', () => {
  it('对着较窄那一栏', () => {
    expect(fitToNarrower(400, 600, 200)).toBe(2);
    expect(fitToNarrower(600, 400, 200)).toBe(2);
  });
});
