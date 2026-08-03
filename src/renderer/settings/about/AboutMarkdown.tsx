import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { makeMarkdownComponents } from '../../panels/main-pane/markdownComponents';

const COMPONENTS = makeMarkdownComponents({ citations: false });

/**
 * 关于页的只读 md 渲染。字号固定，不跟随 --reading-font-size —— 设置页有自己的排版尺度。
 */
export function AboutMarkdown({ content, fontSize = 13.5 }: { content: string; fontSize?: number }) {
  return (
    <div className="font-serif" style={{ fontSize, lineHeight: 1.75, color: 'var(--color-ink)' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
