import { BLOCK_KINDS, type BlockKind } from '../../../../shared/zhSidecar';

/** 模型这一步的输出不合契约。调用方据此补漏 / 重试，仍失败则整页保留原文。 */
export class GroupError extends Error {}

export type TranslatableKind = 'text' | 'title' | 'caption';
/** 这三类要进第二步翻译；其余（formula / table / code / skip）不翻、不盖。补集由测试钉住。 */
export const TRANSLATABLE = new Set<BlockKind>(['text', 'title', 'caption']);
export const isTranslatable = (k: BlockKind): k is TranslatableKind => TRANSLATABLE.has(k);

export type LayoutGroup = { lines: number[]; kind: BlockKind };
export type ParsedGroup = LayoutGroup & { target?: string };

const KINDS = new Set<string>(BLOCK_KINDS);
const list = () => BLOCK_KINDS.join(' / ');

/** 一个 id 的来源：`explicit` 单独列出（如 "7"），`!explicit` 落在某个范围里（如 "1-4" 里的每一个数，含 "5-5" 这种单元素范围）。 */
export type ParsedId = { n: number; explicit: boolean };

export function parseIds(spec: string): ParsedId[] {
  const out: ParsedId[] = [];
  for (const part of spec.split(',')) {
    const s = part.trim();
    if (s === '') throw new GroupError(`行号里有空项：${JSON.stringify(spec)}`);
    const m = /^(\d+)(?:-(\d+))?$/.exec(s);
    if (!m) throw new GroupError(`行号不认识：${JSON.stringify(s)}`);
    const a = Number(m[1]);
    if (m[2] === undefined) { out.push({ n: a, explicit: true }); continue; }
    const b = Number(m[2]);
    if (b < a) throw new GroupError(`行号范围反了：${JSON.stringify(s)}`);
    for (let i = a; i <= b; i++) out.push({ n: i, explicit: false });
  }
  return out;
}

/**
 * 第一步（版面）的输出：每组一行 `<line ids> | <kind>`，按阅读顺序，没有译文（spec 2026-09-07 §4.2）。
 * 划分校验：重复 / 未知行号 / 格式 / kind 照抛；缺行不抛、回 `missing`（调用方只把缺的行再发一次）。
 * 未知行号的检查排在缺行之前：宽松只对缺行宽松。
 */
export function parseLayout(text: string, expected: number[]): { groups: LayoutGroup[]; missing: number[] } {
  const raw: { entries: ParsedId[]; kind: BlockKind }[] = [];
  for (const line0 of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = line0.trim();
    if (line === '') continue;
    const bar = line.indexOf('|');
    if (bar < 0) throw new GroupError(`组行缺少 "|"：${JSON.stringify(line)}`);
    const entries = parseIds(line.slice(0, bar));
    const kind = line.slice(bar + 1).trim();
    if (!KINDS.has(kind)) throw new GroupError(`kind 不认识：${JSON.stringify(kind)}，只认 ${list()}`);
    raw.push({ entries, kind: kind as BlockKind });
  }

  // 每个 id 的显式 / 范围来源各出现几次（跨组累计，也含同一组内的多次，如 "1,1"）。
  const explicitCount = new Map<number, number>();
  const rangeCount = new Map<number, number>();
  for (const g of raw) for (const e of g.entries) {
    const counts = e.explicit ? explicitCount : rangeCount;
    counts.set(e.n, (counts.get(e.n) ?? 0) + 1);
  }
  const allIds = new Set<number>([...explicitCount.keys(), ...rangeCount.keys()]);
  for (const n of allIds) {
    const ec = explicitCount.get(n) ?? 0;
    const rc = rangeCount.get(n) ?? 0;
    // 两个单值来源、或两个范围来源（哪怕都在同一组里）→ 真重复。措辞不预设重复发生在哪。
    if (ec >= 2 || (ec === 0 && rc >= 2)) throw new GroupError(`行 ${n} 重复出现`);
  }
  // 显式优先于范围：一个 id 既落在某个范围里、又被单独列出时（恰好一个单值来源），范围按不含它读。
  const stripFromRanges = new Set<number>();
  for (const [n, ec] of explicitCount) if (ec === 1 && (rangeCount.get(n) ?? 0) > 0) stripFromRanges.add(n);

  const groups: LayoutGroup[] = [];
  const seen = new Set<number>();
  for (const g of raw) {
    const lines = g.entries.filter((e) => e.explicit || !stripFromRanges.has(e.n)).map((e) => e.n);
    for (const n of lines) seen.add(n);
    if (lines.length > 0) groups.push({ lines, kind: g.kind });
  }
  for (const n of seen) if (!expected.includes(n)) throw new GroupError(`行 ${n} 不在这次发出的行里`);
  return { groups, missing: expected.filter((n) => !seen.has(n)) };
}
