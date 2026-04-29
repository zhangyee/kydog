import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

function annotateCitations(node: ReactNode): ReactNode {
  if (typeof node === 'string') {
    const parts = node.split(/(\[\d+\])/g);
    return parts.map((s, i) =>
      /^\[\d+\]$/.test(s)
        ? (
          <sup
            key={i}
            style={{
              color: 'var(--color-accent)',
              fontWeight: 600,
              fontFamily: 'var(--font-serif)',
              fontSize: 11,
              padding: '0 1px',
              cursor: 'pointer',
            }}
          >{s}</sup>
        )
        : s,
    );
  }
  if (Array.isArray(node)) return node.map((n, i) => <span key={i}>{annotateCitations(n)}</span>);
  if (isValidElement(node)) return node;
  return node;
}

const COMPONENTS: Components = {
  p:  ({ children }) => <p style={{ margin: '0 0 12px' }}>{annotateCitations(children)}</p>,
  h2: ({ children }) => <h2 style={{ fontSize: 22, fontWeight: 600, margin: '36px 0 10px', lineHeight: 1.3 }}>{children}</h2>,
  h3: ({ children }) => <h3 style={{ fontSize: 16, fontWeight: 600, margin: '20px 0 8px' }}>{children}</h3>,
  ul: ({ children }) => <ul style={{ margin: '0 0 12px', paddingLeft: 22, lineHeight: 1.8 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: '0 0 14px', paddingLeft: 22, lineHeight: 1.75 }}>{children}</ol>,
  li: ({ children }) => <li>{annotateCitations(children)}</li>,
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
    const isInline = !(className && className.startsWith('language-'));
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

export function MarkdownBlock({ content }: { content: string }) {
  return (
    <div
      className="font-serif"
      style={{ fontSize: 14.5, lineHeight: 1.75, color: 'var(--color-ink)' }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
