import { describe, it, expect } from 'vitest';
import { initDraft, pickOption, setCustom, skipQuestion, goTo, firstUnhandled, toAnswers } from './askDraft';
import type { AskQuestion } from '../../../shared/askQuestion';

const single: AskQuestion = {
  id: 'q0', question: '单选？', header: '单选',
  options: [{ id: 'q0o0', label: 'A', description: 'a' }, { id: 'q0o1', label: 'B', description: 'b' }],
};
const multi: AskQuestion = {
  id: 'q1', question: '多选？', header: '多选', multiSelect: true,
  options: [{ id: 'q1o0', label: 'X', description: 'x' }, { id: 'q1o1', label: 'Y', description: 'y' }],
};
const questions = [single, multi];

describe('askDraft', () => {
  it('初始状态：游标在 0，没有任何终态', () => {
    const d = initDraft();
    expect(d.cursor).toBe(0);
    expect(firstUnhandled(d, questions)).toBe(0);
  });

  it('单选选中后自动前进；最后一题不前进', () => {
    let d = initDraft();
    d = pickOption(d, single, 'q0o0', questions.length);
    expect(d.cursor).toBe(1);
    d = pickOption(d, multi, 'q1o0', questions.length);
    expect(d.cursor).toBe(1);
  });

  it('多选是切换，且停在原地', () => {
    let d = goTo(initDraft(), 1, questions.length);
    d = pickOption(d, multi, 'q1o0', questions.length);
    d = pickOption(d, multi, 'q1o1', questions.length);
    expect(d.byQuestionId['q1']).toEqual({ kind: 'answered', optionIds: ['q1o0', 'q1o1'], custom: '' });
    d = pickOption(d, multi, 'q1o0', questions.length);
    expect(d.byQuestionId['q1']).toEqual({ kind: 'answered', optionIds: ['q1o1'], custom: '' });
    expect(d.cursor).toBe(1);
  });

  it('多选取消最后一个勾选后退回未处理', () => {
    let d = goTo(initDraft(), 1, questions.length);
    d = pickOption(d, multi, 'q1o0', questions.length);
    d = pickOption(d, multi, 'q1o0', questions.length);
    expect(d.byQuestionId['q1']).toBeUndefined();
  });

  it('不变量一：文本 trim 后非空即选中，清空即取消', () => {
    let d = initDraft();
    d = setCustom(d, single, '自己写的');
    expect(d.byQuestionId['q0']).toEqual({ kind: 'answered', optionIds: [], custom: '自己写的' });
    d = setCustom(d, single, '   ');
    expect(firstUnhandled(d, questions)).toBe(0);
  });

  it('不变量二：单选下 custom 非空则 optionIds 为空', () => {
    let d = initDraft();
    d = pickOption(d, single, 'q0o0', questions.length);
    d = setCustom(d, single, '都不是');
    expect(d.byQuestionId['q0']).toEqual({ kind: 'answered', optionIds: [], custom: '都不是' });
  });

  it('单选下点选项会清空 custom', () => {
    let d = setCustom(initDraft(), single, '都不是');
    d = pickOption(d, single, 'q0o1', questions.length);
    expect(d.byQuestionId['q0']).toEqual({ kind: 'answered', optionIds: ['q0o1'], custom: '' });
  });

  it('多选下 custom 与勾选项并存', () => {
    let d = goTo(initDraft(), 1, questions.length);
    d = pickOption(d, multi, 'q1o0', questions.length);
    d = setCustom(d, multi, '补一句');
    expect(d.byQuestionId['q1']).toEqual({ kind: 'answered', optionIds: ['q1o0'], custom: '补一句' });
  });

  it('跳过是终态并前进；最后一题停在原地', () => {
    let d = skipQuestion(initDraft(), single, questions.length);
    expect(d.byQuestionId['q0']).toEqual({ kind: 'skipped' });
    expect(d.cursor).toBe(1);
    d = skipQuestion(d, multi, questions.length);
    expect(d.cursor).toBe(1);
  });

  it('翻页保留草稿', () => {
    let d = pickOption(initDraft(), single, 'q0o0', questions.length);
    d = goTo(d, 0, questions.length);
    expect(d.cursor).toBe(0);
    expect(d.byQuestionId['q0']).toEqual({ kind: 'answered', optionIds: ['q0o0'], custom: '' });
  });

  it('goTo 越界被夹住', () => {
    expect(goTo(initDraft(), -1, 2).cursor).toBe(0);
    expect(goTo(initDraft(), 9, 2).cursor).toBe(1);
  });

  it('firstUnhandled 全部处理完返回 null', () => {
    let d = pickOption(initDraft(), single, 'q0o0', questions.length);
    d = skipQuestion(d, multi, questions.length);
    expect(firstUnhandled(d, questions)).toBeNull();
  });

  it('toAnswers 产出可提交的答案，空 custom 不出现在结果里', () => {
    let d = pickOption(initDraft(), single, 'q0o0', questions.length);
    d = pickOption(d, multi, 'q1o0', questions.length);
    d = setCustom(d, multi, ' 补一句 ');
    expect(toAnswers(d, questions)).toEqual([
      { questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] },
      { questionId: 'q1', kind: 'answered', optionIds: ['q1o0'], custom: '补一句' },
    ]);
  });

  it('toAnswers 把未处理的题也算作 skipped（提交前 UI 已引导过）', () => {
    const d = pickOption(initDraft(), single, 'q0o0', questions.length);
    expect(toAnswers(d, questions)[1]).toEqual({ questionId: 'q1', kind: 'skipped' });
  });

  it('所有函数都不改原对象', () => {
    const d0 = initDraft();
    pickOption(d0, single, 'q0o0', 2);
    setCustom(d0, single, 'x');
    skipQuestion(d0, single, 2);
    goTo(d0, 1, 2);
    expect(d0).toEqual({ cursor: 0, byQuestionId: {} });
  });
});
