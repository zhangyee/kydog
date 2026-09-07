import { GroupError } from './layoutProtocol';

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
