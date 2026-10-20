/** Chat preserves math as source text; no DOM, bridge, or formula renderer. */
import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

export const remarkMathSource: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file);
  visit(tree, (node, index, parent) => {
    if ((node.type !== 'inlineMath' && node.type !== 'math') || !parent || index === undefined) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) throw new Error('Math source offsets are required');
    const text = { type: 'text' as const, value: source.slice(start, end), position: node.position };
    parent.children[index] =
      node.type === 'math' ? { type: 'paragraph', children: [text], position: node.position } : text;
  });
};
