export type PageSize = { w: number; h: number };

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
