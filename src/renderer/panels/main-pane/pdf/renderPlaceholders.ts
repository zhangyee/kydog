import { PLACEHOLDER_TOKEN, type Placeholder, type PlaceholderScript } from '../../../../shared/zhSidecar';

export type Segment = { kind: 'text' | Placeholder['kind']; text: string; script?: PlaceholderScript };

/**
 * 把 target 里的 {vN} 换回 placeholders 里的原文片段。
 * 认不出的 {vN} 按字面量留着不报错 —— 边车是外部产物，一条写坏不该让整块打不开（spec §5）。
 */
export function splitPlaceholders(target: string, placeholders: Placeholder[]): Segment[] {
  const byId = new Map(placeholders.map((p) => [p.id, p]));
  const out: Segment[] = [];
  let last = 0;
  for (const m of target.matchAll(PLACEHOLDER_TOKEN)) {
    const p = byId.get(m[1]);
    if (!p) continue;                                   // 认不出：连同大括号一起留在文本里
    if (m.index > last) out.push({ kind: 'text', text: target.slice(last, m.index) });
    const seg: Segment = { kind: p.kind, text: p.text };
    if (p.script) seg.script = p.script;
    out.push(seg);
    last = m.index + m[0].length;
  }
  if (last < target.length) out.push({ kind: 'text', text: target.slice(last) });
  return out;
}
