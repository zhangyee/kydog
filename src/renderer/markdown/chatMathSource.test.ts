import { it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import { remarkMathSource } from './chatMathSource';

it('restores original inline and block math source including delimiters and spacing', () => {
  const p = unified().use(remarkParse).use(remarkMath).use(remarkMathSource);
  const source = 'before $ a==b== $ after\n\n$$\nx==y==\n$$\n';
  const tree = p.runSync(p.parse(source), source);
  expect(tree.children).toMatchObject([
    {
      type: 'paragraph',
      children: [
        { type: 'text', value: 'before ' },
        { type: 'text', value: '$ a==b== $' },
        { type: 'text', value: ' after' },
      ],
    },
    { type: 'paragraph', children: [{ type: 'text', value: '$$\nx==y==\n$$' }] },
  ]);
});
