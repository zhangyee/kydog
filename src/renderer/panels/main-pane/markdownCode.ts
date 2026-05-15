/**
 * 判断 react-markdown 的 `code` 节点是行内代码还是块级代码。
 *
 * 不能只看 `language-*` class —— 不带语言标签的围栏代码块（裸 ```）生成的
 * `<code>` 也没有 class。可靠信号：块级代码（围栏/缩进）的内容必含换行，
 * 行内代码绝不含换行。
 */
export function isInlineCode(className: string | undefined, children: unknown): boolean {
  if (className?.startsWith('language-')) return false;
  return !String(children).includes('\n');
}
