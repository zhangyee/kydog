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
        询问了 {block.questions.map((q) => q.header).join('、')}
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
