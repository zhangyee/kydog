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

export function parseIds(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const s = part.trim();
    if (s === '') throw new GroupError(`行号里有空项：${JSON.stringify(spec)}`);
    const m = /^(\d+)(?:-(\d+))?$/.exec(s);
    if (!m) throw new GroupError(`行号不认识：${JSON.stringify(s)}`);
    const a = Number(m[1]);
    if (m[2] === undefined) { out.push(a); continue; }
    const b = Number(m[2]);
    if (b < a) throw new GroupError(`行号范围反了：${JSON.stringify(s)}`);
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}

/**
 * 第一步（版面）的输出：每组一行 `<line ids> | <kind>`，按阅读顺序，没有译文（spec 2026-09-07 §4.2）。
 * 划分校验：重复 / 未知行号 / 格式 / kind 照抛；缺行不抛、回 `missing`（调用方只把缺的行再发一次）。
 * 未知行号的检查排在缺行之前：宽松只对缺行宽松。
 */
export function parseLayout(text: string, expected: number[]): { groups: LayoutGroup[]; missing: number[] } {
  const groups: LayoutGroup[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const bar = line.indexOf('|');
    if (bar < 0) throw new GroupError(`组行缺少 "|"：${JSON.stringify(line)}`);
    const ids = parseIds(line.slice(0, bar));
    const kind = line.slice(bar + 1).trim();
    if (!KINDS.has(kind)) throw new GroupError(`kind 不认识：${JSON.stringify(kind)}，只认 ${list()}`);
    groups.push({ lines: ids, kind: kind as BlockKind });
  }
  const seen = new Set<number>();
  for (const g of groups) for (const n of g.lines) {
    if (seen.has(n)) throw new GroupError(`行 ${n} 出现在多个组里`);
    seen.add(n);
  }
  for (const n of seen) if (!expected.includes(n)) throw new GroupError(`行 ${n} 不在这次发出的行里`);
  return { groups, missing: expected.filter((n) => !seen.has(n)) };
}
