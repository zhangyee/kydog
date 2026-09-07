import { BLOCK_KINDS, type BlockKind } from '../../../../shared/zhSidecar';
import { GroupError, TRANSLATABLE, parseIds, type ParsedGroup } from './layoutProtocol';

export { GroupError, TRANSLATABLE, type ParsedGroup };

const KINDS = new Set<string>(BLOCK_KINDS);

export type Partition = { groups: ParsedGroup[]; missing: number[] };

/**
 * 解析 §6 的 `%%` 协议，并做两层校验：**划分**（不重、不漏，对着 `expected`）与
 * **kind ↔ target**（可译的必须有非空译文，不可译的必须没有）。第三层几何校验在 groupGeometry。
 *
 * 为什么不用 JSON：截断只会丢掉尾部整组（划分校验一定抓得到），译文里的引号与换行不用转义,
 * 解析是个好测的纯函数。JSON 被截断则整份不可解析（spec §6）。
 *
 * 行号是不透明 id：**不排序、不过 Set 重建**。顺序是协议字段——buildBlocks 要按它拼 source。
 *
 * 宽松版：**只对缺行宽松**——不抛，把缺的行号按 expected 顺序回给调用方（translateDoc 据此只把
 * 缺的那几行再发一次，spec 2026-09-06 §4.1）。重复 / 未知行号 / 组头格式 / kind↔target 照抛：
 * 那些是模型没按契约走，补不了。
 */
export function partitionGroups(text: string, expected: number[]): Partition {
  const groups: ParsedGroup[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const head = lines[i].trim();
    if (head === '') { i++; continue; }
    const bar = head.indexOf('|');
    if (bar < 0) throw new GroupError(`组头缺少 "|"：${JSON.stringify(head)}`);
    const ids = parseIds(head.slice(0, bar));
    const kind = head.slice(bar + 1).trim();
    if (!KINDS.has(kind)) throw new GroupError(`kind 不认识：${JSON.stringify(kind)}`);
    i++;
    const body: string[] = [];
    let closed = false;
    for (; i < lines.length; i++) {
      if (lines[i].trim() === '%%') { closed = true; i++; break; }
      body.push(lines[i]);
    }
    // 没有闭合的 %% = 输出被截断在这一组里。不收这一组：它的行号因此会从划分里缺席，
    // 下面的「不漏」检查会把整页判为无效——这正是我们要的（半截译文不能当完整的用）。
    if (!closed) break;
    const target = body.join('\n').trim();
    const k = kind as BlockKind;
    if (TRANSLATABLE.has(k)) {
      // 少了这一关，`1-4 | text` 后面直接 %% 会解析成 target: ''，而 RightPage 判的是
      // `target === undefined`——'' 不是 undefined，于是矩形照盖、译文层没字，结果是一块被
      // 涂白的原文。比不翻译糟得多，用户还看不出发生了什么（spec §2.4 c）。
      if (target === '') throw new GroupError(`kind=${k} 的组（行 ${ids.join(',')}）没有译文`);
      groups.push({ lines: ids, kind: k, target });
    } else {
      if (target !== '') throw new GroupError(`kind=${k} 的组（行 ${ids.join(',')}）不该有译文`);
      groups.push({ lines: ids, kind: k });
    }
  }

  const seen = new Set<number>();
  for (const g of groups) {
    for (const n of g.lines) {
      if (seen.has(n)) throw new GroupError(`行 ${n} 出现在多个组里`);
      seen.add(n);
    }
  }
  // 未知行号的检查排在缺行之前：宽松版必须先把「模型编了行号」这类硬错误抛掉，才能安全地把
  // 剩下的缺行回给调用方（否则一份把 x 坐标当行号发回来的输出会被当成「只是缺了几行」补发）。
  for (const n of seen) if (!expected.includes(n)) throw new GroupError(`行 ${n} 不在这次发出的行里`);
  return { groups, missing: expected.filter((n) => !seen.has(n)) };
}

/** 严格版 = partitionGroups 之后缺行即抛。现有调用方与用例语义不变。 */
export function parseGroups(text: string, expected: number[]): ParsedGroup[] {
  const { groups, missing } = partitionGroups(text, expected);
  if (missing.length > 0) throw new GroupError(`行 ${missing[0]} 没有出现在任何组里`);
  return groups;
}
