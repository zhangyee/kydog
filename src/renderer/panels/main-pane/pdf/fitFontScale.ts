/**
 * 二分求「能装进 maxH 的最大字号比例」。
 *
 * measure 由调用方注入：真实调用里它把文本塞进一个 zoom:1 的隐藏宿主量 scrollHeight，
 * 测试里它是一个纯函数。实现因此不需要知道 DOM，测试也不需要 DOM。
 *
 * 结果由调用方按 block.id 缓存，只算一次：在 CSS zoom 容器里量出来的值随缩放变，
 * 每个缩放各算一遍会让同一块在不同倍率下换行位置不同，版面跟着跳（spec §11）。
 */
export function fitFontScale(
  measure: (ratio: number) => number,
  maxH: number,
  minRatio = 0.5,
  steps = 6,
): number {
  if (measure(1) <= maxH) return 1;      // 英译中通常缩短 20–40%，这是常见分支，先走一次
  let lo = minRatio, hi = 1;
  if (measure(minRatio) > maxH) return minRatio;   // 缩到底也不够，交给块内滚动
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (measure(mid) <= maxH) lo = mid; else hi = mid;
  }
  return lo;
}
