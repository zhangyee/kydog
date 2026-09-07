import { GroupError } from './layoutProtocol';
import { PLACEHOLDER_TOKEN } from '../../../../shared/zhSidecar';

/**
 * 第二步（翻译）的输出：每个可译组一个槽位——`<id>` 一行、译文若干行、`%%` 一行
 * （spec 2026-09-07 §4.3）。id 是这一页内的 `g1..gN`。头行允许 `g3 | text` 这种把 kind 回显的写法。
 * 缺组不抛、回 `missing`（调用方只把缺的组再发一次）；未知 / 重复 / 空译文 / 头行不成形照抛。
 * 没闭合的最后一组不收——半截译文不能当完整的用，它会以「缺」的形式进补漏。
 */
export function parseTranslations(text: string, expectedIds: string[]): { targets: Record<string, string>; missing: string[] } {
  const targets: Record<string, string> = {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const head = lines[i].trim();
    if (head === '') { i++; continue; }
    const id = head.split('|')[0].trim();
    if (!/^g\d+$/.test(id)) throw new GroupError(`组头不是 id：${JSON.stringify(head)}`);
    if (!expectedIds.includes(id)) throw new GroupError(`组 ${id} 不在这次发出的组里`);
    if (id in targets) throw new GroupError(`组 ${id} 出现了两次`);
    i++;
    const body: string[] = [];
    let closed = false;
    for (; i < lines.length; i++) {
      if (lines[i].trim() === '%%') { closed = true; i++; break; }
      body.push(lines[i]);
    }
    if (!closed) break;
    const target = body.join('\n').trim();
    if (target === '') throw new GroupError(`组 ${id} 没有译文`);
    targets[id] = target;
  }
  return { targets, missing: expectedIds.filter((id) => !(id in targets)) };
}

/**
 * 译文里出现了原文没有的 `\\` 或 `$`——模型把数学符号改写成了 LaTeX（`\\( v_n \\)`、`$x_i$`、`\\mathcal{S}`），
 * 2512.03413.pdf 第 5 页实测：同一篇别的页都把 𝑣𝑛 原样抄回来，这一页一整份响应全走了 LaTeX 风格
 * （spec 2026-09-07 §8.8）。判据是协议层的：契约要求数学符号逐字照抄，那译文就不可能多出这两个字符；
 * 原文自己带（路径、转义、金额）时不判——只看「原文没有、译文有」。回违约的那个字符，没有则 undefined。
 */
export function introducedMarkup(source: string, target: string): '\\' | '$' | undefined {
  for (const ch of ['\\', '$'] as const) if (target.includes(ch) && !source.includes(ch)) return ch;
  return undefined;
}

export type TokenViolation = { missing: string[]; dup: string[]; unknown: string[] };

/**
 * 每个 `{vN}` 在译文里恰出现一次（spec 2026-09-07 scripts §5.2）。精确计数，不看位置：实测里「左邻字符变了」
 * 的全是脚注号挂在被译单词上——模型做对了，位置校验会误伤，所以不做。三者皆空回 undefined。
 */
export function tokenViolation(source: string, target: string): TokenViolation | undefined {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const x of s.matchAll(PLACEHOLDER_TOKEN)) m.set(x[1], (m.get(x[1]) ?? 0) + 1);
    return m;
  };
  const src = count(source);
  const tgt = count(target);
  const missing = [...src.keys()].filter((id) => !tgt.has(id));
  const dup = [...src.keys()].filter((id) => (tgt.get(id) ?? 0) > 1);
  const unknown = [...tgt.keys()].filter((id) => !src.has(id));
  return missing.length || dup.length || unknown.length ? { missing, dup, unknown } : undefined;
}

/** 失败原因里的那半句：`丢 v1,v2、多出 v9`。 */
export function describeTokenViolation(v: TokenViolation): string {
  return [
    v.missing.length ? `丢 ${v.missing.join(',')}` : '',
    v.dup.length ? `重复 ${v.dup.join(',')}` : '',
    v.unknown.length ? `多出 ${v.unknown.join(',')}` : '',
  ].filter(Boolean).join('、');
}
