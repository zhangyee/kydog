import { PLACEHOLDER_TOKEN, type Block, type PageLine, type Placeholder } from '../../../../shared/zhSidecar';
import { inkRectOf, unionRect } from './blockRect';
import type { ParsedGroup } from './layoutProtocol';

/** 中位数，偶数取较小的那个——为的是确定性，不是统计上的讲究。 */
function median(ns: number[]): number {
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.ceil(s.length / 2) - 1];
}

/**
 * 行尾连字符 + 下一行以小写字母开头 → 去掉连字符直接连；否则用一个空格连。
 *
 * `source` 只进边车给人和 agent 看，不参与渲染，也不参与任何判定，所以这条规则不影响不变量。
 *
 * 两步协议之后它还多了一个身份：第二步发给模型的 `TranslateGroup.source` 就是它拼出来的整段
 * （spec 2026-09-07 §4.3）——模型不再看到分行的原文，接合规则必须只此一份，否则边车里的
 * `source` 与模型实际读到的会是两个串。
 */
export function joinSource(texts: string[]): string {
  let out = '';
  for (const t of texts) {
    if (out === '') { out = t; continue; }
    if (/-$/.test(out) && /^[a-z]/.test(t)) out = out.slice(0, -1) + t;
    else out = `${out} ${t}`;
  }
  return out;
}

/**
 * 记号化（spec 2026-09-07 scripts §3.1）：脚标区间换成 `{vN}`，组内按文本顺序从 v1 起编号。
 *
 * **三个产物出自同一次计算**：`request` 发给模型；`source` 由 `request` 把记号换回原文得到，落边车；
 * `placeholders` 落边车。边车里的 source 与模型读到的串因此由构造保证只差记号——不再各自 joinSource 一次。
 * kind 用 `formula`：三个 kind 里最贴近的，不新增 kind，免得动 PLACEHOLDER_KINDS 那整条契约链。
 */
export function tokenize(lines: PageLine[]): { request: string; source: string; placeholders: Placeholder[] } {
  const placeholders: Placeholder[] = [];
  const tokenized = lines.map((l) => {
    const spans = l.scripts ?? [];
    if (spans.length === 0) return l.text;
    let out = '';
    let pos = 0;
    for (const s of spans) {
      const id = `v${placeholders.length + 1}`;
      placeholders.push({ id, kind: 'formula', text: l.text.slice(s.start, s.end), script: s.kind });
      out += l.text.slice(pos, s.start) + `{${id}}`;
      pos = s.end;
    }
    return out + l.text.slice(pos);
  });
  const request = joinSource(tokenized);
  const byId = new Map(placeholders.map((p) => [p.id, p.text]));
  const source = request.replace(PLACEHOLDER_TOKEN, (m, id: string) => byId.get(id) ?? m);
  return { request, source, placeholders };
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
    // 与 translateDoc 发请求时是同一个 tokenize、同一批行、同一个顺序：落盘的 source / placeholders
    // 与模型读到的串只差记号（spec 2026-09-07 scripts §3.2）。
    const tk = tokenize(ls);
    const block: Block = {
      id: `p${page}-b${String(i + 1).padStart(2, '0')}`,
      page,
      x: r.x, y: r.y, width: r.w, height: r.h,
      fontSize: median(ls.map((l) => l.size)),
      kind: g.kind,
      source: tk.source,
    };
    // target 缺省是「这一块不覆盖」的唯一判据，所以不可译的 kind 必须**不带这个键**，
    // 而不是带一个 undefined —— JSON.stringify 会把 undefined 的键去掉，但显式不写更清楚。
    // placeholders 只在有 target 时才有意义：没译文就没有 {vN} 可还原。
    if (g.target !== undefined) {
      block.target = g.target;
      if (tk.placeholders.length > 0) block.placeholders = tk.placeholders;
    }
    const ink = unionRect(ls.map(inkRectOf));
    block.ink = { top: ink.y, bottom: ink.y + ink.h };
    return block;
  });
}
