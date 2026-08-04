import { describe, it, expect } from 'vitest';
import { answerText } from './QuestionRecapCard';
import type { AskQuestion } from '../../../shared/askQuestion';

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
