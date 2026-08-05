import type { AskBlock } from '../../../shared/types';
import type { AskAnswer, AskQuestion } from '../../../shared/askQuestion';

const NO_ANSWER_NOTE: Record<'pending' | 'cancelled' | 'aborted' | 'unanswered', string> = {
  pending: '等待回答…',
  cancelled: '你关闭了这次提问，未作回答。',
  aborted: '提问被中止，未作回答。',
  unanswered: '应用退出时这次提问还没回答。',
};

export function answerText(q: AskQuestion, a: AskAnswer | undefined): string | null {
  if (!a || a.kind === 'skipped') return null;
  const labelById = new Map(q.options.map((o) => [o.id, o.label]));
  const picked = a.optionIds.map((id) => labelById.get(id) ?? id).join('、');
  const custom = a.custom?.trim() ?? '';
  if (picked && custom) return `${picked}；${custom}`;
  return picked || custom;
}

/**
 * 摘要行只陈述结构事实，不拼模型生成的 `header`。
 *
 * `header` 当初的唯一用途是「卡片折叠时的摘要行」，但这张卡片没做折叠——
 * 于是那行变成三个 ≤12 字的短词硬拼，既和下面的问题全文重复、又不成句。
 * 状态不在这里说：非 answered 的情况由卡片底部的说明承担。
 */
export function recapSummary(block: AskBlock): string {
  const base = `询问了 ${block.questions.length} 个问题`;
  if (block.status !== 'answered') return base;
  const skipped = block.answers.filter((a) => a.kind === 'skipped').length;
  return skipped > 0 ? `${base}，跳过 ${skipped} 题` : base;
}

export function QuestionRecapCard({ block }: { block: AskBlock }) {
  const byId = new Map((block.status === 'answered' ? block.answers : []).map((a) => [a.questionId, a]));

  return (
    <div
      data-testid="ask-recap"
      data-status={block.status}
      style={{
        margin: '10px 0',
        border: '0.5px solid var(--color-ink-hair)',
        borderRadius: 4,
        background: 'var(--color-paper)',
        padding: '10px 12px',
      }}
    >
      <div
        className="font-mono"
        style={{ fontSize: 10, color: 'var(--color-ink-faint)', marginBottom: 6 }}
      >
        {recapSummary(block)}
      </div>
      {block.questions.map((q) => {
        const text = answerText(q, byId.get(q.id));
        return (
          <div key={q.id} style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 12 }}>
            <span style={{ flex: 1, color: 'var(--color-ink-soft)' }}>{q.question}</span>
            <span style={{ color: text ? 'var(--color-ink)' : 'var(--color-ink-faint)' }}>
              {text ?? (block.status === 'answered' ? '（跳过）' : '—')}
            </span>
          </div>
        );
      })}
      {block.status !== 'answered' && (
        <div style={{ fontSize: 11, color: 'var(--color-ink-faint)', marginTop: 6 }}>
          {NO_ANSWER_NOTE[block.status]}
        </div>
      )}
    </div>
  );
}
