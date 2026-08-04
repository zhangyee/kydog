import { describe, it, expect, beforeEach } from 'vitest';
import { useAskStore } from './askStore';
import type { AskQuestion } from '../../shared/askQuestion';

const questions: AskQuestion[] = [{
  id: 'q0', question: '选哪个？', header: '选择',
  options: [{ id: 'q0o0', label: 'A', description: 'a' }, { id: 'q0o1', label: 'B', description: 'b' }],
}];

describe('askStore', () => {
  beforeEach(() => useAskStore.setState({ pendingByThread: {}, draftByThread: {} }));

  it('open 后能取到 pending 和初始草稿', () => {
    useAskStore.getState().open('t1', 'tc1', questions);
    const s = useAskStore.getState();
    expect(s.pendingByThread['t1']).toEqual({ toolCallId: 'tc1', questions });
    expect(s.draftByThread['t1']?.cursor).toBe(0);
  });

  it('close 同时清掉 pending 和草稿', () => {
    useAskStore.getState().open('t1', 'tc1', questions);
    useAskStore.getState().close('t1', 'tc1');
    const s = useAskStore.getState();
    expect(s.pendingByThread['t1']).toBeUndefined();
    expect(s.draftByThread['t1']).toBeUndefined();
  });

  it('toolCallId 对不上的 close 被忽略', () => {
    useAskStore.getState().open('t1', 'tc1', questions);
    useAskStore.getState().close('t1', 'OTHER');
    expect(useAskStore.getState().pendingByThread['t1']).toBeDefined();
  });

  it('没有 pending 时 close 不抛错', () => {
    expect(() => useAskStore.getState().close('t1', 'tc1')).not.toThrow();
  });

  it('两个 thread 的 pending 互不干扰', () => {
    useAskStore.getState().open('t1', 'tc1', questions);
    useAskStore.getState().open('t2', 'tc2', questions);
    useAskStore.getState().close('t1', 'tc1');
    expect(useAskStore.getState().pendingByThread['t2']).toBeDefined();
    expect(useAskStore.getState().draftByThread['t2']).toBeDefined();
  });

  it('updateDraft 只改指定 thread 的草稿', () => {
    useAskStore.getState().open('t1', 'tc1', questions);
    useAskStore.getState().open('t2', 'tc2', questions);
    useAskStore.getState().updateDraft('t1', (d) => ({ ...d, cursor: 0, byQuestionId: { q0: { kind: 'skipped' } } }));
    expect(useAskStore.getState().draftByThread['t1']?.byQuestionId['q0']).toEqual({ kind: 'skipped' });
    expect(useAskStore.getState().draftByThread['t2']?.byQuestionId['q0']).toBeUndefined();
  });

  it('没有草稿时 updateDraft 是 no-op', () => {
    expect(() => useAskStore.getState().updateDraft('nope', (d) => d)).not.toThrow();
    expect(useAskStore.getState().draftByThread['nope']).toBeUndefined();
  });

  it('重新 open 会重置草稿', () => {
    useAskStore.getState().open('t1', 'tc1', questions);
    useAskStore.getState().updateDraft('t1', (d) => ({ ...d, cursor: 5 }));
    useAskStore.getState().open('t1', 'tc2', questions);
    expect(useAskStore.getState().draftByThread['t1']?.cursor).toBe(0);
  });
});
