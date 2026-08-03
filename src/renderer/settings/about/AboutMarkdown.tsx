import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { makeMarkdownComponents } from '../../panels/main-pane/markdownComponents';

// 两张表都建在模块层：react-markdown 按引用比较 components，
// 放进组件体里每次渲染都会重建，整棵子树跟着重挂。
const COMPONENTS = makeMarkdownComponents({ citations: false });
const COMPONENTS_SOFT = makeMarkdownComponents({ citations: false, softBreaks: true });

/**
 * 关于页的只读 md 渲染。字号固定，不跟随 --reading-font-size —— 设置页有自己的排版尺度。
 *
 * softBreaks：让段落里的单个换行照原样断行。CommonMark 规定软换行折叠成空格，
 * 落款那种「Yee ⏎ 2026年8月3日」就会挤成一行；用 white-space: pre-line 让它按写的样子断，
 * 作者不必为了换行去插空行或补两个尾随空格。
 * 只给正文用，不给 licenses 用 —— OFL 原文是按 72 字硬折的，在宽栏里保留那些折行会很碎。
 */
export function AboutMarkdown(
  { content, fontSize = 13.5, softBreaks = false }:
  { content: string; fontSize?: number; softBreaks?: boolean },
) {
  return (
    <div className="font-serif" style={{ fontSize, lineHeight: 1.75, color: 'var(--color-ink)' }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={softBreaks ? COMPONENTS_SOFT : COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
