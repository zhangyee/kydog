export type PageSize = { w: number; h: number };

// 页间距与上下留白的基准（px，随缩放等比）。放在这里而不是 PdfFileTab：它们是版面几何的一部分，
// 与 unitLayout 同源；e2e 也要按同一份数字反算 scrollHeight 与滚动目标，从组件文件 import
// 会把 react-pdf / pdf.js worker 那一整串副作用拖进 Playwright 的 node 上下文。
export const PAGE_GAP = 16;
export const PAGE_PAD = 24;

/**
 * 每页在 scale 1 下的顶边偏移与内容总高，单位 pt。
 *
 * 现有布局的 gap 与 padding 都是按 scale 等比给的（PdfFileTab 的 `gap: PAGE_GAP * scale`），
 * 所以这份 scale 1 的偏移乘以任意 scale 就是那个缩放下的真实像素——不需要为每个缩放各算一遍。
 *
 * 为什么必须算而不是量 DOM：虚拟化之后窗口外的页没有内容，高度得先给出来才撑得住 scrollHeight。
 */
export function unitLayout(sizes: PageSize[], gap: number, pad: number): { tops: number[]; total: number } {
  const tops: number[] = [];
  let y = pad;
  for (const s of sizes) {
    tops.push(y);
    y += s.h + gap;
  }
  // 最后一页后面没有 gap，减掉；空文档时压根没加过
  return { tops, total: (sizes.length ? y - gap : y) + pad };
}
