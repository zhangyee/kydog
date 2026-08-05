import { describe, it, expect } from 'vitest';
import { renderOutcome } from './askAnswers';
import { validateQuestions } from './askValidate';

const questions = validateQuestions({
  questions: [
    { question: '落在哪个分支？', header: '分支', options: [
      { label: '当前 worktree', description: 'a' }, { label: '新开一个', description: 'b' },
    ] },
    { question: '跑哪些验证？', header: '验证', multiSelect: true, options: [
      { label: 'tsc', description: 'a' }, { label: 'vitest', description: 'b' },
    ] },
    { question: '怎么交付？', header: '交付', options: [
      { label: 'PR', description: 'a' }, { label: '直接推', description: 'b' },
    ] },
  ],
});

describe('renderOutcome', () => {
  it('answered 逐题列出选中的 label', () => {
    const text = renderOutcome(questions, { kind: 'answered', answers: [
      { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] },
      { questionId: 'q1', kind: 'answered', optionIds: ['q1o0', 'q1o1'] },
      { questionId: 'q2', kind: 'skipped' },
    ] });
    expect(text).toBe(
      '用户回答：\n' +
      '- 落在哪个分支？ → 当前 worktree\n' +
      '- 跑哪些验证？ → tsc、vitest\n' +
      '- 怎么交付？ → （用户跳过了这一题）',
    );
  });

  it('custom 跟在选项后面', () => {
    const text = renderOutcome(questions, { kind: 'answered', answers: [
      { questionId: 'q0', kind: 'answered', optionIds: [], custom: '再开个 worktree' },
      { questionId: 'q1', kind: 'answered', optionIds: ['q1o0'], custom: '顺手跑 lint' },
      { questionId: 'q2', kind: 'skipped' },
    ] });
    expect(text).toContain('- 落在哪个分支？ → 再开个 worktree');
    expect(text).toContain('- 跑哪些验证？ → tsc；另外用户补充：顺手跑 lint');
  });

  it('answers 里缺席的题当作跳过', () => {
    const text = renderOutcome(questions, { kind: 'answered', answers: [
      { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] },
    ] });
    expect(text).toContain('- 跑哪些验证？ → （用户跳过了这一题）');
    expect(text).toContain('- 怎么交付？ → （用户跳过了这一题）');
  });

  it('题目顺序按 questions 而不是 answers', () => {
    const text = renderOutcome(questions, { kind: 'answered', answers: [
      { questionId: 'q2', kind: 'answered', optionIds: ['q2o0'] },
      { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] },
      { questionId: 'q1', kind: 'skipped' },
    ] });
    const lines = text.split('\n');
    expect(lines[1]).toContain('落在哪个分支？');
    expect(lines[2]).toContain('跑哪些验证？');
    expect(lines[3]).toContain('怎么交付？');
  });

  it('cancelled 不列任何答案', () => {
    expect(renderOutcome(questions, { kind: 'cancelled' })).toBe('用户关闭了提问，未作回答。');
  });

  it('aborted 有自己的文案，与 cancelled 不同', () => {
    expect(renderOutcome(questions, { kind: 'aborted' })).toBe('提问被中止，用户未作回答。');
    expect(renderOutcome(questions, { kind: 'aborted' }))
      .not.toBe(renderOutcome(questions, { kind: 'cancelled' }));
  });
});
