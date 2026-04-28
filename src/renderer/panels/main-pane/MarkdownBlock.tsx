import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownBlock({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none font-serif text-[color:var(--color-ink)]">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
