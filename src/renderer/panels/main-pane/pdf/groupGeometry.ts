import type { PageLine } from '../../../../shared/zhSidecar';
import { containsCenter, inkRectOf, paddedRect, unionRect, type Rect } from './blockRect';
import { GroupError, isTranslatable, type LayoutGroup, type ParsedGroup } from './layoutProtocol';

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
    const hit = coveredForeign(paddedRect(unionRect(rects)), lines, own);
    if (hit) throw new GroupError(`组（行 ${g.lines.join(',')}）的覆盖矩形盖住了不属于它的行 ${hit.n}`);
  }
}

/** `mask` 盖住的第一条不属于 `own` 的行（按 `lines` 顺序），没有则 undefined。 */
function coveredForeign(mask: Rect, lines: PageLine[], own: Set<number>): PageLine | undefined {
  return lines.find((l) => !own.has(l.n) && containsCenter(mask, inkRectOf(l)));
}

/**
 * 几何不合的组先拆再校验（spec 2026-09-07 §8.7）。
 *
 * 一段从左栏底接到右栏顶是双栏论文的常态：模型按语义把它归成一组是对的，但一个块只有一个
 * 矩形，两栏的并集横竖都跨整个版心，必然盖住别组的行——2512.03413.pdf 第 5 页因此四次版面
 * 四次被判掉，重试改变不了几何。提示词里「另一栏隔在两半之间就发两组」这条规则模型不稳
 * 定地遵守，所以校验层不能只会拒绝：拒绝换来的重试是同一份几何。
 *
 * 拆法不是启发式：判据就是 checkGroupGeometry 那一条（外扩后的墨迹并集不含别组行的中心），
 * 按模型给的行序贪心地切成**极大连续段**——下一行并进来会盖住别组的行，就在它前面切开。
 * 拆出来的每一段都再过一遍同一个校验，过不了照样抛（单独一行就盖住别人的那种，拆也救不了）。
 * 「别组的行」按拆之前的组算：同一组里还没并进来的行不算外人，否则内容流交错的段落会被切碎。
 *
 * 代价说清楚：跨栏的一段被译成两块，栏尾那句在译文里断在栏边——与「图隔在两半之间」那条
 * 既有取舍相同。译文层一个块一个矩形，这是块模型的边界，不是这里能补的。
 */
export function repairGroupGeometry(groups: LayoutGroup[], lines: PageLine[]): LayoutGroup[] {
  const byId = new Map(lines.map((l) => [l.n, l]));
  const out: LayoutGroup[] = [];
  for (const g of groups) {
    if (!isTranslatable(g.kind)) { out.push(g); continue; }
    const own = new Set(g.lines);
    const rectOf = (n: number): Rect | undefined => { const l = byId.get(n); return l ? inkRectOf(l) : undefined; };
    const covers = (rects: Rect[]) => rects.length > 0 && coveredForeign(paddedRect(unionRect(rects)), lines, own) !== undefined;
    if (!covers(g.lines.map(rectOf).filter((r): r is Rect => !!r))) { out.push(g); continue; }
    let run: number[] = [];
    let runRects: Rect[] = [];
    for (const n of g.lines) {
      const r = rectOf(n);
      if (r && run.length > 0 && covers([...runRects, r])) {
        out.push({ lines: run, kind: g.kind });
        run = [];
        runRects = [];
      }
      run.push(n);
      if (r) runRects.push(r);
    }
    if (run.length > 0) out.push({ lines: run, kind: g.kind });
  }
  checkGroupGeometry(out, lines);
  return out;
}
