import type { Node as PmNode } from '@milkdown/kit/prose/model';

/**
 * 选区起点往前最近的 heading 的文字（不论级别；起点在标题里就是它自己）。
 * 从文档结构上找，不靠猜（spec §2.3）。`nodesBetween(0, pos)` 按文档顺序走过所有起点在 pos 之前、
 * 或覆盖 pos 的节点，最后一个被走到的 heading 就是最近的那个。
 */
export function sectionAt(doc: PmNode, pos: number): string | undefined {
  let found: string | undefined;
  doc.nodesBetween(0, Math.max(1, Math.min(pos, doc.content.size)), (node) => {
    if (node.type.name === 'heading') found = node.textContent.trim() || undefined;
    return true;
  });
  return found;
}

/** 选区的纯文本快照：块之间换行，非文字的行内节点代入其源码。 */
export function quoteOf(doc: PmNode, from: number, to: number): string {
  return doc.textBetween(from, to, '\n', (leaf) => {
    switch (leaf.type.name) {
      case 'math_inline': return `$${String(leaf.attrs.value ?? '')}$`;
      case 'image': return String(leaf.attrs.alt ?? '');
      case 'image-block': return String(leaf.attrs.caption ?? '');
      case 'hardbreak': return '\n';
      default: return '';
    }
  }).trim();
}
