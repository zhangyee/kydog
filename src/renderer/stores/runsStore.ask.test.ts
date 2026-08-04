import { describe, it, expect, beforeEach } from 'vitest';
import { useRunsStore } from './runsStore';
import type { AskQuestion } from '../../shared/askQuestion';

const questions: AskQuestion[] = [{
  id: 'q0', question: '选哪个？', header: '选择',
  options: [{ id: 'q0o0', label: 'A', description: 'a' }, { id: 'q0o1', label: 'B', description: 'b' }],
}];

describe('runsStore ask block', () => {
  beforeEach(() => {
    useRunsStore.setState({ bufferByMessage: {}, activeThinkingStartByMessage: {} });
  });

  it('addAskBlock 插入 pending 状态的 block', () => {
    const s = useRunsStore.getState();
    s.startMessageBuffer('t1', 'm1');
    s.addAskBlock('m1', 'tc1', questions);
    expect(useRunsStore.getState().bufferByMessage['m1'].blocks).toEqual([
      { kind: 'ask', toolCallId: 'tc1', questions, status: 'pending' },
    ]);
  });

  it('finalizeAskBlock 用 answered 结果补上 answers', () => {
    const s = useRunsStore.getState();
    s.startMessageBuffer('t1', 'm1');
    s.addAskBlock('m1', 'tc1', questions);
    const answers = [{ questionId: 'q0', kind: 'answered' as const, optionIds: ['q0o0'] }];
    s.finalizeAskBlock('m1', 'tc1', { kind: 'answered', answers });
    expect(useRunsStore.getState().bufferByMessage['m1'].blocks[0]).toEqual({
      kind: 'ask', toolCallId: 'tc1', questions, status: 'answered', answers,
    });
  });

  it('cancelled / aborted 不带 answers', () => {
    const s = useRunsStore.getState();
    s.startMessageBuffer('t1', 'm1');
    s.addAskBlock('m1', 'tc1', questions);
    s.finalizeAskBlock('m1', 'tc1', { kind: 'cancelled' });
    expect(useRunsStore.getState().bufferByMessage['m1'].blocks[0]).toEqual({
      kind: 'ask', toolCallId: 'tc1', questions, status: 'cancelled',
    });
  });

  it('从 answered 再被 cancelled 覆盖时 answers 字段被清掉', () => {
    const s = useRunsStore.getState();
    s.startMessageBuffer('t1', 'm1');
    s.addAskBlock('m1', 'tc1', questions);
    s.finalizeAskBlock('m1', 'tc1', { kind: 'answered', answers: [{ questionId: 'q0', kind: 'skipped' }] });
    s.finalizeAskBlock('m1', 'tc1', { kind: 'aborted' });
    expect(useRunsStore.getState().bufferByMessage['m1'].blocks[0]).not.toHaveProperty('answers');
  });

  it('toolCallId 对不上时不改任何 block', () => {
    const s = useRunsStore.getState();
    s.startMessageBuffer('t1', 'm1');
    s.addAskBlock('m1', 'tc1', questions);
    s.finalizeAskBlock('m1', 'OTHER', { kind: 'cancelled' });
    expect((useRunsStore.getState().bufferByMessage['m1'].blocks[0] as { status: string }).status).toBe('pending');
  });

  it('messageId 不存在时静默忽略，不抛错', () => {
    const s = useRunsStore.getState();
    expect(() => s.addAskBlock('nope', 'tc1', questions)).not.toThrow();
    expect(() => s.finalizeAskBlock('nope', 'tc1', { kind: 'cancelled' })).not.toThrow();
  });

  it('addAskBlock 会先结掉正在进行的 thinking', () => {
    const s = useRunsStore.getState();
    s.startMessageBuffer('t1', 'm1');
    s.appendThinking('m1', '想一下');
    s.addAskBlock('m1', 'tc1', questions);
    const blocks = useRunsStore.getState().bufferByMessage['m1'].blocks;
    expect(blocks[0].kind).toBe('thinking');
    expect((blocks[0] as { status: string }).status).toBe('done');
  });

  it('ask block 跟着 takeBuffer 一起被取走', () => {
    const s = useRunsStore.getState();
    s.startMessageBuffer('t1', 'm1');
    s.addAskBlock('m1', 'tc1', questions);
    const blocks = useRunsStore.getState().takeBuffer('m1');
    expect(blocks?.[0].kind).toBe('ask');
    expect(useRunsStore.getState().bufferByMessage['m1']).toBeUndefined();
  });
});
