import type { PageLine } from '../../../../shared/zhSidecar';
import { containsCenter, inkRectOf, paddedRect, unionRect } from './blockRect';
import { GroupError, isTranslatable, type ParsedGroup } from './layoutProtocol';

/**
 * 第三层校验（spec §2.4 b）：对每个**有 target** 的组，它实际填色的那个矩形
 * （墨迹框并集再外扩 BLOCK_PAD，缺省退回字身框——与 RightPage 的 fillRect 同一份口径）里，
 * 不许出现不属于它的行的中心点。
 *
 * 这一条替掉了初稿的「组内行号必须连续」。连续性是「bbox 紧凑」的**代理**，两个方向都不成立:
 * 内容流左右交错时同一段落会拿到 {1,3}（合法分组被禁掉），而连续的 {1,2} 也可能分属两栏
 * （非法分组被放行）。这里检的是真正在乎的那件事——这个块的覆盖矩形会不会盖住别人的行。
 *
 * 只查**可译 kind** 的组：其余 kind 不填色（RightPage 对没有 target 的块直接 continue，而
 * target 只会落在可译组上），它的矩形不存在。判据是 kind 不是「有没有 target」：两步协议里这
 * 一关跑在第一步之后、译文还没回来，那时**每个组的 target 都是 undefined**，按 target 判等于
 * 整层校验静默失效——能编译、全绿、盖字照发生（spec 2026-09-07 §4.2「校验：划分 + 几何（只对
 * text / title / caption 组）」）。
 *
 * 保证的强度到「不会**整行地**盖住」为止，边缘擦碰仍可能——见 blockRect.containsCenter 的注释。
 *
 * mask 与被查行的中心必须同一口径（都是墨迹框，缺省退回字身框）：字体挂在基线下的大算符
 * （ascent 很小、descent 很大，如 cmex 那类）字身框中心会落进上一段的 mask，但它的墨迹根本
 * 不在那——两侧口径不一致就会误判（spec 2026-09-07 §8.3，2512.03413.pdf 第 8 页实测）。
 */
export function checkGroupGeometry(groups: ParsedGroup[], lines: PageLine[]): void {
  const byId = new Map(lines.map((l) => [l.n, l]));
  for (const g of groups) {
    if (!isTranslatable(g.kind)) continue;
    const own = new Set(g.lines);
    const rects = g.lines.map((n) => byId.get(n)).filter((l): l is PageLine => !!l).map(inkRectOf);
    if (rects.length === 0) continue;
    const mask = paddedRect(unionRect(rects));
    for (const l of lines) {
      if (own.has(l.n)) continue;
      if (containsCenter(mask, inkRectOf(l))) {
        throw new GroupError(`组（行 ${g.lines.join(',')}）的覆盖矩形盖住了不属于它的行 ${l.n}`);
      }
    }
  }
}
