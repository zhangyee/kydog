import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { remarkHighlight } from '../../markdown/highlightSyntax';
import { remarkMathSource } from '../../markdown/chatMathSource';
import { makeMarkdownComponents } from './markdownComponents';

const COMPONENTS = makeMarkdownComponents({ citations: true });

export function MarkdownBlock({ content }: { content: string }) {
  return (
    <div
      className="font-serif"
      style={{
        fontSize: 'var(--reading-font-size)',
        lineHeight: 'var(--reading-line-height)',
        color: 'var(--color-ink)',
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkHighlight, remarkMathSource]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
