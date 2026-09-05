import type { Block, PageLine } from '../../../../shared/zhSidecar';
import { unionRect } from './blockRect';
import type { ParsedGroup } from './parseGroups';

/** 中位数，偶数取较小的那个——为的是确定性，不是统计上的讲究。 */
function median(ns: number[]): number {
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.ceil(s.length / 2) - 1];
}

/**
 * 行尾连字符 + 下一行以小写字母开头 → 去掉连字符直接连；否则用一个空格连。
 *
 * `source` 只进边车给人和 agent 看，不参与渲染，也不参与任何判定，所以这条规则不影响不变量。
 * 模型拿到的是**分行的原文**（prompt 里逐行给），译文由它自己接合，不依赖这里拼出来的串。
 */
function joinSource(texts: string[]): string {
  let out = '';
  for (const t of texts) {
    if (out === '') { out = t; continue; }
    if (/-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
    else out = `${out} ${t}`;
  }
  return out;
}

/**
 * 组 + 行 → 边车块（spec §5）。**坐标全部在这里算，模型碰不到**——这是「模型出错也错不出版面
 * 错位」那条不变量的落点。
 *
 * `seq` 按组的**最小行号**升序编，不按模型给出的组序：组序会随模型输出顺序变，最小行号不会,
 * 所以同一页重译两次得到同一组 id。
 */
export function buildBlocks(page: number, lines: PageLine[], groups: ParsedGroup[]): Block[] {
  const byId = new Map(lines.map((l) => [l.n, l]));
  const resolved = groups
    .map((g) => ({ g, ls: g.lines.map((n) => byId.get(n)).filter((l): l is PageLine => !!l) }))
    .filter((r) => r.ls.length > 0)
    .sort((a, b) => Math.min(...a.g.lines) - Math.min(...b.g.lines));

  return resolved.map(({ g, ls }, i) => {
    const r = unionRect(ls.map((l) => ({ x: l.x, y: l.y, w: l.w, h: l.h })));
    const block: Block = {
      id: `p${page}-b${String(i + 1).padStart(2, '0')}`,
      page,
      x: r.x, y: r.y, width: r.w, height: r.h,
      fontSize: median(ls.map((l) => l.size)),
      kind: g.kind,
      source: joinSource(ls.map((l) => l.text)),
    };
    // target 缺省是「这一块不覆盖」的唯一判据，所以不可译的 kind 必须**不带这个键**，
    // 而不是带一个 undefined —— JSON.stringify 会把 undefined 的键去掉，但显式不写更清楚。
    if (g.target !== undefined) block.target = g.target;
    return block;
  });
}
