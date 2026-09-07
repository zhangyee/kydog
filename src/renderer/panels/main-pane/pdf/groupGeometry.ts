import type { PageLine } from '../../../../shared/zhSidecar';
import { containsCenter, inkRectOf, paddedRect, unionRect, type Rect } from './blockRect';
import { GroupError, type ParsedGroup } from './parseGroups';

const rectOf = (l: PageLine): Rect => ({ x: l.x, y: l.y, w: l.w, h: l.h });

/**
 * 第三层校验（spec §2.4 b）：对每个**有 target** 的组，它实际填色的那个矩形
 * （墨迹框并集再外扩 BLOCK_PAD，缺省退回字身框——与 RightPage 的 fillRect 同一份口径）里，
 * 不许出现不属于它的行的中心点。
 *
 * 这一条替掉了初稿的「组内行号必须连续」。连续性是「bbox 紧凑」的**代理**，两个方向都不成立:
 * 内容流左右交错时同一段落会拿到 {1,3}（合法分组被禁掉），而连续的 {1,2} 也可能分属两栏
 * （非法分组被放行）。这里检的是真正在乎的那件事——这个块的覆盖矩形会不会盖住别人的行。
 *
 * 只查有 target 的组：没有 target 的组不填色（RightPage 直接 continue），它的矩形不存在。
 *
 * 保证的强度到「不会**整行地**盖住」为止，边缘擦碰仍可能——见 blockRect.containsCenter 的注释。
 */
export function checkGroupGeometry(groups: ParsedGroup[], lines: PageLine[]): void {
  const byId = new Map(lines.map((l) => [l.n, l]));
  for (const g of groups) {
    if (g.target === undefined) continue;
    const own = new Set(g.lines);
    const rects = g.lines.map((n) => byId.get(n)).filter((l): l is PageLine => !!l).map(inkRectOf);
    if (rects.length === 0) continue;
    const mask = paddedRect(unionRect(rects));
    for (const l of lines) {
      if (own.has(l.n)) continue;
      if (containsCenter(mask, rectOf(l))) {
        throw new GroupError(`组（行 ${g.lines.join(',')}）的覆盖矩形盖住了不属于它的行 ${l.n}`);
      }
    }
  }
}
