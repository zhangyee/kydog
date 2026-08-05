import { describe, it, expect, beforeEach } from 'vitest';
import { QuestionBroker } from './questionBroker';
import { validateQuestions } from './askValidate';
import type { AskAnswer } from '../../shared/askQuestion';

const questions = validateQuestions({
  questions: [{ question: '选哪个？', header: '选择', options: [
    { label: 'A', description: 'a' }, { label: 'B', description: 'b' },
  ] }],
});
const answers: AskAnswer[] = [{ questionId: 'q0', kind: 'answered', optionIds: ['q0o0'] }];

describe('QuestionBroker', () => {
  let broker: QuestionBroker;
  beforeEach(() => { broker = new QuestionBroker(); });

  it('submit 让挂起的 Promise 以 answered 收尾', async () => {
    const p = broker.ask('t1', 'tc1', questions, undefined);
    expect(broker.submit('t1', 'tc1', answers)).toBe(true);
    await expect(p).resolves.toEqual({ kind: 'answered', answers });
  });

  it('submit 用规范化后的答案 resolve，而不是入参原样', async () => {
    const p = broker.ask('t1', 'tc1', questions, undefined);
    broker.submit('t1', 'tc1', [
      { questionId: 'q0', kind: 'answered', optionIds: [], custom: '  自己写的  ' },
    ]);
    await expect(p).resolves.toEqual({
      kind: 'answered',
      answers: [{ questionId: 'q0', kind: 'answered', optionIds: [], custom: '自己写的' }],
    });
  });

  it('cancel 以 cancelled 收尾', async () => {
    const p = broker.ask('t1', 'tc1', questions, undefined);
    expect(broker.cancel('t1', 'tc1')).toBe(true);
    await expect(p).resolves.toEqual({ kind: 'cancelled' });
  });

  it('abort 走 resolve 而不是 reject，且结果是 aborted', async () => {
    const ac = new AbortController();
    const p = broker.ask('t1', 'tc1', questions, ac.signal);
    ac.abort();
    await expect(p).resolves.toEqual({ kind: 'aborted' });
  });

  it('注册时 signal 已经 abort 则立刻 resolve 成 aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(broker.ask('t1', 'tc1', questions, ac.signal)).resolves.toEqual({ kind: 'aborted' });
  });

  it('signal 已 abort 时不留下 pending，可以立刻再开一轮', async () => {
    const ac = new AbortController();
    ac.abort();
    await broker.ask('t1', 'tc1', questions, ac.signal);
    const p = broker.ask('t1', 'tc2', questions, undefined);
    expect(broker.cancel('t1', 'tc2')).toBe(true);
    await p;
  });

  it('toolCallId 不匹配的 submit / cancel 被丢弃，Promise 仍挂起', async () => {
    const p = broker.ask('t1', 'tc1', questions, undefined);
    expect(broker.submit('t1', 'STALE', answers)).toBe(false);
    expect(broker.cancel('t1', 'STALE')).toBe(false);
    let settled = false;
    void p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    broker.cancel('t1', 'tc1');
    await p;
  });

  it('threadId 不匹配的 submit 被丢弃', async () => {
    const p = broker.ask('t1', 'tc1', questions, undefined);
    expect(broker.submit('OTHER', 'tc1', answers)).toBe(false);
    broker.cancel('t1', 'tc1');
    await p;
  });

  it('submit 的答案不合法时抛错，pending 保持不变', async () => {
    const p = broker.ask('t1', 'tc1', questions, undefined);
    expect(() => broker.submit('t1', 'tc1', [
      { questionId: 'q0', kind: 'answered', optionIds: ['NOPE'] },
    ])).toThrow(/optionId/);
    expect(broker.submit('t1', 'tc1', answers)).toBe(true);
    await expect(p).resolves.toEqual({ kind: 'answered', answers });
  });

  it('同一 thread 重复 ask 抛错（sequential + 批次独占本应杜绝）', () => {
    void broker.ask('t1', 'tc1', questions, undefined);
    expect(() => broker.ask('t1', 'tc2', questions, undefined)).toThrow(/已有/);
    broker.cancel('t1', 'tc1');
  });

  it('不同 thread 的 pending 互不干扰', async () => {
    const p1 = broker.ask('t1', 'tc1', questions, undefined);
    const p2 = broker.ask('t2', 'tc2', questions, undefined);
    broker.cancel('t1', 'tc1');
    await expect(p1).resolves.toEqual({ kind: 'cancelled' });
    expect(broker.submit('t2', 'tc2', answers)).toBe(true);
    await expect(p2).resolves.toEqual({ kind: 'answered', answers });
  });

  it('结算后 pending 被清掉，可以再开一轮', async () => {
    const p1 = broker.ask('t1', 'tc1', questions, undefined);
    broker.cancel('t1', 'tc1');
    await p1;
    const p2 = broker.ask('t1', 'tc2', questions, undefined);
    expect(broker.submit('t1', 'tc2', answers)).toBe(true);
    await expect(p2).resolves.toEqual({ kind: 'answered', answers });
  });

  it('结算后再 abort 同一个 signal 不会二次结算', async () => {
    const ac = new AbortController();
    const p = broker.ask('t1', 'tc1', questions, ac.signal);
    broker.submit('t1', 'tc1', answers);
    ac.abort();
    await expect(p).resolves.toEqual({ kind: 'answered', answers });
  });
});
