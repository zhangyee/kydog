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
 * `Block.source`（边车里落盘的那份、去记号的明文）只给人和 agent 看，不参与渲染、不参与判定，
 * 这条规则改动不影响任何不变量。
 *
 * 但两步协议之后同名的 `TranslateGroup.source`（第二步发给模型的那份，即 `tokenize().request`，
 * 带 `{vN}` 记号）不是同一回事：它是 `introducedMarkup` 与 `tokenViolation` 两条协议层校验的输入
 * （spec 2026-09-07 §4.3、scripts §5.2）。接合规则必须只此一份，否则边车里的明文 `source`、模型
 * 实际读到的请求串、校验时用的串会变成三份不同的东西。
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
  // 正文本身可能字面含 "{v1}" 这样的串（讲 prompt 模板、贴 JSON 样例的段落不算稀奇，KyDog 自己的
  // 领域尤其常见）。编号如果撞上这种字面量，两种后果都不体面：模型把两处 {v1} 都原样抄回来 → 协议层
  // 判 dup → 重发 → 仍 dup → 整页失败，而失败原因指向"记号对不上"，其实是正文自己就有这串字面量；
  // 模型只回一个 → missing/dup/unknown 都不响、校验放行，但落盘的 source 会把正文那段字面 {v1} 静默
  // 换成脚标原文。跳过法：编号前先枚举这一组正文（记号化之前的原文）里出现过的 v\d+，凡撞上就跳过，
  // 让 tokenize 插入的记号永远不会与正文字面重名——这是协议层可枚举的事实，不是近似或阈值。
  const literalIds = new Set<string>();
  for (const l of lines) for (const m of l.text.matchAll(PLACEHOLDER_TOKEN)) literalIds.add(m[1]);
  let n = 0;
  const nextId = (): string => {
    let id: string;
    do { n++; id = `v${n}`; } while (literalIds.has(id));
    return id;
  };

  const placeholders: Placeholder[] = [];
  const tokenized = lines.map((l) => {
    const spans = l.scripts ?? [];
    if (spans.length === 0) return l.text;
    let out = '';
    let pos = 0;
    for (const s of spans) {
      const id = nextId();
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
 * 组的行号 → 行对象，按行号原本给出的顺序（不重排）。**translateDoc.ts 的 `runPage` 与本文件的
 * `buildBlocks` 都只能调这一份**，不能各自抄一遍：边车里落盘的 `source` 与模型实际读到的请求串
 * 只差记号这条不变量，靠的就是两处用同一批行、同一顺序算出 `tokenize(...)`；两份复制品一旦漂移
 * （排序、过滤方式不一致），下游「译文里的记号对不对得上原文」的校验就建立在错的前提上，而且
 * 多行组才会暴露，单行组的测试用例照样全绿。
 */
export function linesOfGroup(lineNumbers: number[], byId: Map<number, PageLine>): PageLine[] {
  return lineNumbers.map((n) => byId.get(n)).filter((l): l is PageLine => !!l);
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
    .map((g) => ({ g, ls: linesOfGroup(g.lines, byId) }))
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
