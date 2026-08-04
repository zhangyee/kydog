import { describe, it, expect } from 'vitest';
import { validateQuestions } from './askValidate';
import type { RawAskQuestion } from '../../shared/askQuestion';

const opt = (label: string, description = 'd') => ({ label, description });
const q = (over: Partial<RawAskQuestion> = {}): RawAskQuestion => ({
  question: '选哪个？',
  header: '选择',
  options: [opt('A'), opt('B')],
  ...over,
});

describe('validateQuestions', () => {
  it('合法输入按下标分配 id', () => {
    const out = validateQuestions({ questions: [q(), q({ question: '再选一个？' })] });
    expect(out[0].id).toBe('q0');
    expect(out[1].id).toBe('q1');
    expect(out[0].options.map((o) => o.id)).toEqual(['q0o0', 'q0o1']);
    expect(out[1].options.map((o) => o.id)).toEqual(['q1o0', 'q1o1']);
  });

  it('id 分配是确定的：同样输入两次结果一致', () => {
    const input = { questions: [q()] };
    expect(validateQuestions(input)).toEqual(validateQuestions(input));
  });

  it('保留 multiSelect 与 recommended', () => {
    const out = validateQuestions({
      questions: [q({ multiSelect: true, options: [{ ...opt('A'), recommended: true }, opt('B')] })],
    });
    expect(out[0].multiSelect).toBe(true);
    expect(out[0].options[0].recommended).toBe(true);
  });

  it('questions 为空或超过 4 条都拒绝', () => {
    expect(() => validateQuestions({ questions: [] })).toThrow(/1[–-]4/);
    expect(() => validateQuestions({ questions: [q(), q(), q(), q(), q()] })).toThrow(/1[–-]4/);
  });

  it('选项少于 2 或多于 4 都拒绝', () => {
    expect(() => validateQuestions({ questions: [q({ options: [opt('A')] })] })).toThrow(/2[–-]4/);
    expect(() =>
      validateQuestions({ questions: [q({ options: [opt('A'), opt('B'), opt('C'), opt('D'), opt('E')] })] }),
    ).toThrow(/2[–-]4/);
  });

  it('一题里两个 recommended 拒绝', () => {
    expect(() =>
      validateQuestions({
        questions: [q({ options: [{ ...opt('A'), recommended: true }, { ...opt('B'), recommended: true }] })],
      }),
    ).toThrow(/recommended/);
  });

  it('纯空白的 question / header / label / description 都算空', () => {
    expect(() => validateQuestions({ questions: [q({ question: '   ' })] })).toThrow(/question/);
    expect(() => validateQuestions({ questions: [q({ header: '\t' })] })).toThrow(/header/);
    expect(() => validateQuestions({ questions: [q({ options: [opt('  '), opt('B')] })] })).toThrow(/label/);
    expect(() => validateQuestions({ questions: [q({ options: [opt('A', ' '), opt('B')] })] })).toThrow(/description/);
  });

  it('header 超过 12 字符拒绝', () => {
    expect(() => validateQuestions({ questions: [q({ header: '一二三四五六七八九十十一十二十三' })] })).toThrow(/header/);
  });

  it('问题文本重复拒绝（trim 后比较）', () => {
    expect(() => validateQuestions({ questions: [q(), q({ question: ' 选哪个？ ' })] })).toThrow(/重复/);
  });

  it('同题内 label 重复拒绝（trim 后比较）', () => {
    expect(() => validateQuestions({ questions: [q({ options: [opt('A'), opt(' A ')] })] })).toThrow(/重复/);
  });

  it('不是数组的 questions 拒绝', () => {
    expect(() => validateQuestions({ questions: 'nope' })).toThrow();
    expect(() => validateQuestions({})).toThrow();
  });

  it('正好 4 条 questions 通过', () => {
    expect(validateQuestions({ questions: [q(), q({ question: 'b？' }), q({ question: 'c？' }), q({ question: 'd？' })] }))
      .toHaveLength(4);
  });

  it('正好 4 个选项通过', () => {
    const out = validateQuestions({ questions: [q({ options: [opt('A'), opt('B'), opt('C'), opt('D')] })] });
    expect(out[0].options).toHaveLength(4);
  });

  it('正好 12 字符的 header 通过', () => {
    expect(() => validateQuestions({ questions: [q({ header: '一二三四五六七八九十十一' })] })).not.toThrow();
  });

  it('输出里的 question 与 label 是 trim 过的', () => {
    const out = validateQuestions({ questions: [q({ question: '  选哪个？  ', options: [opt(' A '), opt('B')] })] });
    expect(out[0].question).toBe('选哪个？');
    expect(out[0].options[0].label).toBe('A');
  });
});
