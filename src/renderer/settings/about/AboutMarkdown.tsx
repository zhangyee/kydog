import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { makeMarkdownComponents } from '../../panels/main-pane/markdownComponents';

const COMPONENTS = makeMarkdownComponents({ citations: false });
// 授权框那种小容器（fontSize 11.5）专用：标题不撑到跟页面 <h1> 一样大。
const COMPACT_COMPONENTS = makeMarkdownComponents({ citations: false, compactHeadings: true });

/**
 * 关于页的只读 md 渲染。字号固定，不跟随 --reading-font-size —— 设置页有自己的排版尺度。
 * compact —— 用在授权框这类小容器里，标题跟着 fontSize 收紧，不用页面正文那套大标题尺寸。
 */
export function AboutMarkdown({ content, fontSize = 13.5, compact = false }: { content: string; fontSize?: number; compact?: boolean }) {
  return (
    <div className="font-serif" style={{ fontSize, lineHeight: 1.75, color: 'var(--color-ink)' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={compact ? COMPACT_COMPONENTS : COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
