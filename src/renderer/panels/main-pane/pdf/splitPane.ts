// 分栏比例与 fit-width 的纯算（对照壳 spec v8 §3.1）。

/** 一栏窄到这个数就没法读了。是可读性常数，不是比例拟合。 */
export const MIN_PANE_PX = 120;
/** 分隔线的命中区宽（线本身 0.5px，两侧各留一点好抓）。 */
export const DIVIDER_PX = 8;

/** 由 wrapper 宽与比例算两栏宽（都扣掉分隔线）。 */
export function paneWidths(wrapperWidth: number, split: number): { left: number; right: number } {
  const usable = Math.max(0, wrapperWidth - DIVIDER_PX);
  const left = usable * split;
  return { left, right: usable - left };
}

/**
 * 拖动分隔线：指针 x → 左栏比例。两侧各留 MIN_PANE_PX；wrapper 窄到放不下两个最小栏时钉在中间
 * （那时怎么拖都没有合法位置，钉中间比左右乱跳好）。
 */
export function clampSplit(pointerX: number, wrapperLeft: number, wrapperWidth: number): number {
  const usable = wrapperWidth - DIVIDER_PX;
  if (usable <= 2 * MIN_PANE_PX) return 0.5;
  const x = pointerX - wrapperLeft;
  const lo = MIN_PANE_PX;
  const hi = usable - MIN_PANE_PX;
  return Math.min(hi, Math.max(lo, x)) / usable;
}

/**
 * 进对照的 fit-width 对着**较窄**那一栏：对着宽栏 fit 会让窄栏被裁，对着窄栏 fit 顶多让宽栏留白，
 * 留白比裁掉好（spec v8 §3.1）。
 */
export function fitToNarrower(leftW: number, rightW: number, pageW: number): number {
  return Math.min(leftW, rightW) / pageW;
}
