import { useState, type CSSProperties } from 'react';

type Props = {
  /** 显示用的路径：项目内是相对路径。 */
  file: string;
  section?: string;
  quote: string;
  note: string;
  onRemove?: () => void;
  onOpenSource?: () => void;
  testId?: string;
};

const RESET: CSSProperties = { background: 'transparent', border: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' };

/** 一条批注（2A）：出处 · 引文 · 批注。紧凑显示，点卡片展开全文、再点收起（spec §2.4）。 */
export function CommentCard({ file, section, quote, note, onRemove, onOpenSource, testId = 'comment-card' }: Props) {
  const [expanded, setExpanded] = useState(false);
  const clamp = (lines: number): CSSProperties => (expanded
    ? {}
    : { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' });
  const label = section ? `${file} · ${section}` : file;
  return (
    <div
      data-testid={testId} data-expanded={expanded ? 'true' : 'false'}
      onClick={() => setExpanded((v) => !v)}
      style={{
        position: 'relative', padding: '6px 28px 6px 10px', borderLeft: '2px solid var(--color-marginalia)',
        background: 'var(--color-paper-edge)', borderRadius: 3, cursor: 'pointer',
      }}
    >
      <div className="font-mono truncate" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
        {onOpenSource ? (
          <button type="button" data-testid="comment-source" onClick={(e) => { e.stopPropagation(); onOpenSource(); }} style={{ ...RESET, textDecoration: 'underline' }}>
            {label}
          </button>
        ) : label}
      </div>
      <div className="font-serif" style={{ fontSize: 13, color: 'var(--color-ink-soft)', whiteSpace: 'pre-wrap', ...clamp(1) }}>“{quote}”</div>
      {note ? <div className="font-serif" style={{ fontSize: 13, color: 'var(--color-ink)', whiteSpace: 'pre-wrap', ...clamp(2) }}>{note}</div> : null}
      {onRemove ? (
        <button
          type="button" data-testid="comment-remove" aria-label="删除这条批注"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{ ...RESET, position: 'absolute', top: 4, right: 8, color: 'var(--color-ink-faint)', fontSize: 12 }}
        >×</button>
      ) : null}
    </div>
  );
}
