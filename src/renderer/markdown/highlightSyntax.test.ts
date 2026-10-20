import { describe, it, expect } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkStringify from 'remark-stringify';
import { visit } from 'unist-util-visit';
import { toString } from 'mdast-util-to-string';
import { remarkHighlight, type Highlight } from './highlightSyntax';

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkHighlight)
  .use(remarkStringify);
const parse = (source: string) => processor.runSync(processor.parse(source));
const highlights = (source: string) => {
  const nodes: Highlight[] = [];
  visit(parse(source), 'highlight', (node) => {
    nodes.push(node);
  });
  return nodes;
};
describe('double equals source grammar', () => {
  it('round trips Chinese and English with nested inline formatting', () => {
    expect(processor.stringify(parse('==高亮==\n'))).toBe('==高亮==\n');
    expect(highlights('==one== and ==二==').map((node) => toString(node))).toEqual(['one', '二']);
    expect(highlights('==**bold** [link](https://example.org)==')[0].children.map((n) => n.type)).toEqual([
      'strong',
      'text',
      'link',
    ]);
    expect(highlights('==one\ntwo==').map((node) => toString(node))).toEqual(['one\ntwo']);
    expect(highlights('==a `code` *em*==')[0].children.map((n) => n.type)).toEqual([
      'text',
      'inlineCode',
      'text',
      'emphasis',
    ]);
  });
  it.each([
    '`==code==`',
    '```txt\n==code==\n```',
    '$a==b==$',
    '$$\na==b==\n$$',
    '\\=\\=文本==',
    '====',
    '===文本===',
    '== 空白==',
    '==\u00a0blank==',
    '==blank\u3000==',
    '==尾空白 ==',
    'a == b',
    '==unclosed',
    '==one\n\ntwo==',
    '[link](https://example.org/==url==)',
    '[link][ref]\n\n[ref]: https://example.org/==url==',
    '<https://example.org/==url==>',
  ])('protects %s at source boundaries', (sample) => {
    const source = `==control==\n\n${sample}\n`;
    expect(highlights(source).map((node) => toString(node))).toEqual(['control']);
    expect(highlights(processor.stringify(parse(source))).map((node) => toString(node))).toEqual(['control']);
    const semanticTree = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === 'position' ? undefined : item));
    expect(semanticTree(parse(processor.stringify(parse(source))))).toEqual(semanticTree(parse(source)));
  });
  it('preserves literal equals when serializing ordinary text', () => {
    const tree = parse('==control==');
    tree.children.push({ type: 'paragraph', children: [{ type: 'text', value: '==literal==' }] });
    expect(highlights(processor.stringify(tree)).map((node) => toString(node))).toEqual(['control']);
  });
});
