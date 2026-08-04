import type { AskAnswer, AskQuestion } from '../../../shared/askQuestion';

/** 草稿里的 custom 始终是原文；判定与提交时才 trim。 */
export type QuestionDraft =
  | { kind: 'answered'; optionIds: string[]; custom: string }
  | { kind: 'skipped' };

export type AskDraft = {
  cursor: number;
  byQuestionId: Record<string, QuestionDraft | undefined>;
};

export function initDraft(): AskDraft {
  return { cursor: 0, byQuestionId: {} };
}

/**
 * 不变量一：`custom.trim() !== ''` ⟺ 自定义行被选中。
 * 所以「什么都没有」的 answered 要退化成未处理，而不是留一个空壳终态。
 */
function normalize(d: AskDraft, questionId: string, next: QuestionDraft): AskDraft {
  const empty =
    next.kind === 'answered' && next.optionIds.length === 0 && next.custom.trim() === '';
  return {
    ...d,
    byQuestionId: { ...d.byQuestionId, [questionId]: empty ? undefined : next },
  };
}

function current(d: AskDraft, q: AskQuestion): { optionIds: string[]; custom: string } {
  const cur = d.byQuestionId[q.id];
  return cur && cur.kind === 'answered'
    ? { optionIds: cur.optionIds, custom: cur.custom }
    : { optionIds: [], custom: '' };
}

function advance(d: AskDraft, total: number): AskDraft {
  return { ...d, cursor: Math.min(d.cursor + 1, total - 1) };
}

export function pickOption(d: AskDraft, q: AskQuestion, optionId: string, total: number): AskDraft {
  const { optionIds, custom } = current(d, q);
  if (q.multiSelect) {
    const next = optionIds.includes(optionId)
      ? optionIds.filter((id) => id !== optionId)
      : [...optionIds, optionId];
    // 多选：切换后停在原地，custom 不受影响。
    return normalize(d, q.id, { kind: 'answered', optionIds: next, custom });
  }
  // 单选：排他 —— 选项与 custom 二选一（不变量二），并自动前进。
  const picked = normalize(d, q.id, { kind: 'answered', optionIds: [optionId], custom: '' });
  return advance(picked, total);
}

export function setCustom(d: AskDraft, q: AskQuestion, text: string): AskDraft {
  const { optionIds } = current(d, q);
  // 单选下只要开始打字就清空已选项；多选下并存。
  const nextOptionIds = q.multiSelect ? optionIds : (text.trim() === '' ? optionIds : []);
  return normalize(d, q.id, { kind: 'answered', optionIds: nextOptionIds, custom: text });
}

export function skipQuestion(d: AskDraft, q: AskQuestion, total: number): AskDraft {
  const skipped: AskDraft = { ...d, byQuestionId: { ...d.byQuestionId, [q.id]: { kind: 'skipped' } } };
  return advance(skipped, total);
}

export function goTo(d: AskDraft, index: number, total: number): AskDraft {
  return { ...d, cursor: Math.max(0, Math.min(index, total - 1)) };
}

/** 第一道既没答案又没被跳过的题，全处理完返回 null。 */
export function firstUnhandled(d: AskDraft, questions: AskQuestion[]): number | null {
  const i = questions.findIndex((q) => d.byQuestionId[q.id] === undefined);
  return i === -1 ? null : i;
}

/** 未处理的题按 skipped 提交 —— 提交前 UI 已经把用户引导到那一题了。 */
export function toAnswers(d: AskDraft, questions: AskQuestion[]): AskAnswer[] {
  return questions.map((q) => {
    const cur = d.byQuestionId[q.id];
    if (!cur || cur.kind === 'skipped') return { questionId: q.id, kind: 'skipped' };
    const custom = cur.custom.trim();
    return {
      questionId: q.id,
      kind: 'answered',
      optionIds: cur.optionIds,
      ...(custom === '' ? {} : { custom }),
    };
  });
}
