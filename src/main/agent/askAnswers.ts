import type { AskOutcome, AskQuestion } from '../../shared/askQuestion';

/** 把结果渲染成模型能读的文本。三种 outcome 各有各的说法，不合并。 */
export function renderOutcome(questions: AskQuestion[], outcome: AskOutcome): string {
  if (outcome.kind === 'cancelled') return '用户关闭了提问，未作回答。';
  if (outcome.kind === 'aborted') return '提问被中止，用户未作回答。';

  const byId = new Map(outcome.answers.map((a) => [a.questionId, a]));
  const lines = questions.map((q) => {
    const a = byId.get(q.id);
    if (!a || a.kind === 'skipped') return `- ${q.question} → （用户跳过了这一题）`;

    const labelById = new Map(q.options.map((o) => [o.id, o.label]));
    const picked = a.optionIds.map((id) => labelById.get(id) ?? id).join('、');
    const custom = typeof a.custom === 'string' ? a.custom.trim() : '';

    if (picked && custom) return `- ${q.question} → ${picked}；另外用户补充：${custom}`;
    if (picked) return `- ${q.question} → ${picked}`;
    return `- ${q.question} → ${custom}`;
  });

  return ['用户回答：', ...lines].join('\n');
}
