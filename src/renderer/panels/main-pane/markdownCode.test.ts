import { describe, it, expect } from 'vitest';
import { isInlineCode } from './markdownCode';

describe('isInlineCode', () => {
  it('带 language-* class 的 code 是块级', () => {
    expect(isInlineCode('language-js', 'const x = 1')).toBe(false);
    expect(isInlineCode('language-markdown', '# title')).toBe(false);
  });

  it('不带语言的围栏代码块（内容含换行）是块级', () => {
    // react-markdown 对裸 ``` 围栏块生成 <code>（无 class），内容必带换行
    expect(isInlineCode(undefined, 'line1\nline2\n')).toBe(false);
    expect(isInlineCode(undefined, 'foo\n')).toBe(false);
  });

  it('行内代码（无 class、无换行）是行内', () => {
    expect(isInlineCode(undefined, 'Vector RAG')).toBe(true);
    expect(isInlineCode(undefined, 'fastpaper search')).toBe(true);
  });

  it('非 language-* 的 class 且无换行仍是行内', () => {
    expect(isInlineCode('some-class', 'x')).toBe(true);
  });
});
