import { it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownBlock } from './MarkdownBlock';

it('renders highlights in chat, preserving code, escaped source, math and GFM tables', () => {
  const html = renderToStaticMarkup(<MarkdownBlock content={'==control==\n\n\\=\\=escaped== `$a==b==$` $a==b==$\n\n$$\nx==y==\n$$\n\n| A |\n|---|\n| ==cell== |'} />);
  expect(html).toContain('<mark class="kydog-highlight">control</mark>');
  expect(html).toContain('<td><mark class="kydog-highlight">cell</mark></td>');
  expect(html.match(/<mark /g)).toHaveLength(2);
  expect(html).toContain('==escaped==');
  expect(html).toMatch(/<code[^>]*>\$a==b==\$<\/code>/);
  expect(html).toContain('<span>$a==b==$</span>');
  expect(html).toContain('$$\nx==y==\n$$');
});
