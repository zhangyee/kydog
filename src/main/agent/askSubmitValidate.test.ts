import { describe, it, expect } from 'vitest';
import { validateQuestions, validateAnswers } from './askValidate';
import type { AskAnswer } from '../../shared/askQuestion';

const questions = validateQuestions({
  questions: [
    { question: '单选题？', header: '单选', options: [
      { label: 'A', description: 'a' }, { label: 'B', description: 'b' },
    ] },
    { question: '多选题？', header: '多选', multiSelect: true, options: [
      { label: 'X', description: 'x' }, { label: 'Y', description: 'y' },
    ] },
  ],
});

const ok: AskAnswer[] = [
  { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] },
  { questionId: 'q1', kind: 'answered', optionIds: ['q1o0', 'q1o1'] },
];

describe('validateAnswers', () => {
  it('合法答案通过', () => {
    expect(() => validateAnswers(questions, ok)).not.toThrow();
  });

  it('skipped 也是合法终态', () => {
    expect(() => validateAnswers(questions, [
      { questionId: 'q0', kind: 'skipped' },
      { questionId: 'q1', kind: 'skipped' },
    ])).not.toThrow();
  });

  it('单选题的 custom 与 optionIds 互斥', () => {
    expect(() => validateAnswers(questions, [
      { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'], custom: '别的' },
      ok[1],
    ])).toThrow(/互斥/);
  });

  it('多选题的 custom 可与勾选项并存', () => {
    expect(() => validateAnswers(questions, [
      ok[0],
      { questionId: 'q1', kind: 'answered', optionIds: ['q1o0'], custom: '补一句' },
    ])).not.toThrow();
  });

  it('未知 questionId 拒绝', () => {
    expect(() => validateAnswers(questions, [
      { questionId: 'q9', kind: 'skipped' }, ok[0], ok[1],
    ])).toThrow(/questionId/);
  });

  it('重复 questionId 拒绝', () => {
    expect(() => validateAnswers(questions, [ok[0], ok[0], ok[1]])).toThrow(/重复/);
  });

  it('optionId 不属于该题拒绝', () => {
    expect(() => validateAnswers(questions, [
      { questionId: 'q0', kind: 'answered', optionIds: ['q1o0'] }, ok[1],
    ])).toThrow(/optionId/);
  });

  it('同题内 optionId 重复拒绝', () => {
    expect(() => validateAnswers(questions, [
      ok[0], { questionId: 'q1', kind: 'answered', optionIds: ['q1o0', 'q1o0'] },
    ])).toThrow(/重复/);
  });

  it('单选题多于一个 optionId 拒绝', () => {
    expect(() => validateAnswers(questions, [
      { questionId: 'q0', kind: 'answered', optionIds: ['q0o0', 'q0o1'] }, ok[1],
    ])).toThrow(/单选/);
  });

  it('answered 既无 optionId 又无非空 custom 拒绝', () => {
    expect(() => validateAnswers(questions, [
      { questionId: 'q0', kind: 'answered', optionIds: [], custom: '   ' }, ok[1],
    ])).toThrow(/至少/);
  });

  it('漏掉一题拒绝', () => {
    expect(() => validateAnswers(questions, [ok[0]])).toThrow(/每道题/);
  });
});
