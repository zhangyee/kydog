import { describe, it, expect } from 'vitest';
import { answerText, recapSummary } from './QuestionRecapCard';
import type { AskQuestion } from '../../../shared/askQuestion';
import type { AskBlock } from '../../../shared/types';

const q: AskQuestion = {
  id: 'q0', question: '选哪个？', header: '选择',
  options: [{ id: 'q0o0', label: 'A', description: 'a' }, { id: 'q0o1', label: 'B', description: 'b' }],
};

describe('answerText', () => {
  it('没有答案返回 null', () => {
    expect(answerText(q, undefined)).toBeNull();
  });

  it('跳过返回 null', () => {
    expect(answerText(q, { questionId: 'q0', kind: 'skipped' })).toBeNull();
  });

  it('单个选项显示 label', () => {
    expect(answerText(q, { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] })).toBe('A');
  });

  it('多个选项用顿号连接', () => {
    expect(answerText(q, { questionId: 'q0', kind: 'answered', optionIds: ['q0o0', 'q0o1'] })).toBe('A、B');
  });

  it('只有 custom 时直接显示 custom', () => {
    expect(answerText(q, { questionId: 'q0', kind: 'answered', optionIds: [], custom: '自己写的' }))
      .toBe('自己写的');
  });

  it('选项与 custom 并存时用分号连接', () => {
    expect(answerText(q, { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'], custom: '补一句' }))
      .toBe('A；补一句');
  });

  it('custom 前后空白被 trim', () => {
    expect(answerText(q, { questionId: 'q0', kind: 'answered', optionIds: [], custom: '  x  ' })).toBe('x');
  });

  it('未知 optionId 兜底显示 id 本身而不是崩', () => {
    expect(answerText(q, { questionId: 'q0', kind: 'answered', optionIds: ['NOPE'] })).toBe('NOPE');
  });
});

describe('recapSummary', () => {
  const three: AskQuestion[] = [q, { ...q, id: 'q1' }, { ...q, id: 'q2' }];

  it('只陈述题数，不拼 header', () => {
    const block: AskBlock = { kind: 'ask', toolCallId: 't', questions: three, status: 'cancelled' };
    expect(recapSummary(block)).toBe('询问了 3 个问题');
    // header 不参与摘要 —— 换掉三个 header 的值，摘要不变。
    const renamed: AskBlock = {
      ...block, questions: three.map((x) => ({ ...x, header: '换个词' })),
    };
    expect(recapSummary(renamed)).toBe(recapSummary(block));
  });

  it('全部答完不提跳过', () => {
    expect(recapSummary({
      kind: 'ask', toolCallId: 't', questions: three, status: 'answered',
      answers: three.map((x) => ({ questionId: x.id, kind: 'answered', optionIds: ['q0o0'] })),
    })).toBe('询问了 3 个问题');
  });

  it('有跳过时补上跳过题数', () => {
    expect(recapSummary({
      kind: 'ask', toolCallId: 't', questions: three, status: 'answered',
      answers: [
        { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] },
        { questionId: 'q1', kind: 'skipped' },
        { questionId: 'q2', kind: 'skipped' },
      ],
    })).toBe('询问了 3 个问题，跳过 2 题');
  });

  it('非 answered 态不数跳过——状态由卡片底部的说明承担', () => {
    for (const status of ['pending', 'aborted', 'unanswered'] as const) {
      expect(recapSummary({ kind: 'ask', toolCallId: 't', questions: three, status }))
        .toBe('询问了 3 个问题');
    }
  });

  it('单题也说得通', () => {
    expect(recapSummary({ kind: 'ask', toolCallId: 't', questions: [q], status: 'cancelled' }))
      .toBe('询问了 1 个问题');
  });
});
