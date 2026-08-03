import { isValidElement, type CSSProperties, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import { isInlineCode } from './markdownCode';

const CITATION_STYLE: CSSProperties = {
  color: 'var(--color-accent)',
  fontWeight: 600,
  fontFamily: 'var(--font-serif)',
  fontSize: 11,
  padding: '0 1px',
  cursor: 'pointer',
};

function annotateCitations(node: ReactNode): ReactNode {
  if (typeof node === 'string') {
    const parts = node.split(/(\[\d+\])/g);
    return parts.map((s, i) =>
      /^\[\d+\]$/.test(s)
        ? <sup key={i} style={CITATION_STYLE}>{s}</sup>
        : s,
    );
  }
  if (Array.isArray(node)) return node.map((n, i) => <span key={i}>{annotateCitations(n)}</span>);
  if (isValidElement(node)) return node;
  return node;
}

/**
 * react-markdown 的组件表。
 * citations: true  —— 对话消息用，把正文里的 [1] 标成引用上标。
 * citations: false —— 关于页等散文用，方括号数字保持原样。
 * softBreaks: true —— 段落内的单个换行照原样断行（CommonMark 默认折叠成空格）。
 */
export function makeMarkdownComponents(opts: { citations: boolean; softBreaks?: boolean }): Components {
  const inline = opts.citations ? annotateCitations : (node: ReactNode) => node;
  const heading = { h1: { fontSize: 26, margin: '28px 0 12px' }, h2: { fontSize: 22, margin: '36px 0 10px' }, h3: { fontSize: 16, margin: '20px 0 8px' } };
  // pre-line 只挂 p / li，不挂容器：块与块之间也夹着换行文本节点，
  // 挂在容器上会把段落间距、列表项间距一起撑开。
  const soft: CSSProperties = opts.softBreaks ? { whiteSpace: 'pre-line' } : {};
  return {
    p:  ({ children }) => <p style={{ margin: '0 0 12px', ...soft }}>{inline(children)}</p>,
    h1: ({ children }) => <h1 style={{ ...heading.h1, fontWeight: 600, lineHeight: 1.25 }}>{children}</h1>,
    h2: ({ children }) => <h2 style={{ ...heading.h2, fontWeight: 600, lineHeight: 1.3 }}>{children}</h2>,
    h3: ({ children }) => <h3 style={{ ...heading.h3, fontWeight: 600, lineHeight: 1.3 }}>{children}</h3>,
    // listStyleType 必须显式写：Tailwind preflight 给 ul/ol 设了 list-style: none，
    // 只给 paddingLeft 的话缩进在、项目符号没了，列表看起来跟普通段落一样。
    ul: ({ children }) => <ul style={{ margin: '0 0 12px', paddingLeft: 22, lineHeight: 1.8, listStyleType: 'disc' }}>{children}</ul>,
    ol: ({ children }) => <ol style={{ margin: '0 0 14px', paddingLeft: 22, lineHeight: 1.75, listStyleType: 'decimal' }}>{children}</ol>,
    li: ({ children }) => <li style={soft}>{inline(children)}</li>,
    a:  ({ href, children }) => {
      const isExternal = !!href && /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file:');
      return (
        <a
          href={href}
          style={{ color: 'var(--color-marginalia)', textDecoration: 'underline', textDecorationColor: 'var(--color-accent-soft)' }}
          {...(isExternal ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
        >{children}</a>
      );
    },
    code: ({ children, className }) => {
      const isInline = isInlineCode(className, children);
      if (isInline) {
        return (
          <code
            className="font-mono"
            style={{ fontSize: 12, padding: '1px 6px', background: 'var(--color-paper-deep)', border: '0.5px solid var(--color-ink-hair-soft)', borderRadius: 2 }}
          >{children}</code>
        );
      }
      return <code className={className}>{children}</code>;
    },
    pre: ({ children }) => (
      <pre
        className="font-mono"
        style={{
          margin: '12px 0', padding: '12px 14px', background: '#1f1a15',
          color: '#d9cfbf', borderRadius: 2, fontSize: 12, lineHeight: 1.6, overflowX: 'auto',
        }}
      >{children}</pre>
    ),
    blockquote: ({ children }) => (
      <blockquote
        style={{
          margin: '14px 0', padding: '8px 16px',
          borderLeft: '3px solid var(--color-accent)',
          fontStyle: 'italic', color: 'var(--color-ink-soft)',
          background: 'oklch(0.97 0.025 70 / 0.4)',
        }}
      >{children}</blockquote>
    ),
  };
}
