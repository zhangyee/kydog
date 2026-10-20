import { describe, it, expect, beforeEach } from 'vitest';
import { useAskStore } from './askStore';
import type { AskQuestion } from '../../shared/askQuestion';

const questions: AskQuestion[] = [{
  id: 'q0', question: '选哪个？', header: '选择',
  options: [{ id: 'q0o0', label: 'A', description: 'a' }, { id: 'q0o1', label: 'B', description: 'b' }],
}];

describe('askStore', () => {
  beforeEach(() => useAskStore.setState({ pendingByThread: {}, draftByThread: {}, submissionByThread: {} }));

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

describe('askStore 提交请求身份', () => {
  beforeEach(() => useAskStore.setState({ pendingByThread: {}, draftByThread: {}, submissionByThread: {} }));

  it('只有当前 pending 能开始提交，重复与成功后继续提交被拒绝，thread 互不干扰', () => {
    const store = useAskStore.getState();
    store.open('t1', 'tc1', questions);
    store.open('t2', 'tc2', questions);
    expect(store.beginSubmit('t1', 'tc1')).toBe(true);
    expect(useAskStore.getState().submissionByThread.t1).toEqual({ toolCallId: 'tc1', status: 'submitting' });
    expect(store.beginSubmit('t1', 'tc1')).toBe(false);
    expect(store.beginSubmit('t2', 'wrong')).toBe(false);
    expect(store.beginSubmit('missing', 'tc1')).toBe(false);
    expect(store.beginSubmit('t2', 'tc2')).toBe(true);
    store.finishSubmit('t1', 'tc1');
    expect(useAskStore.getState().submissionByThread.t1).toEqual({ toolCallId: 'tc1', status: 'submitted' });
    expect(useAskStore.getState().submissionByThread.t2).toEqual({ toolCallId: 'tc2', status: 'submitting' });
    expect(store.beginSubmit('t1', 'tc1')).toBe(false);
  });

  it('失败保留草稿，允许重试并清除错误', () => {
    const store = useAskStore.getState();
    store.open('t1', 'tc1', questions);
    store.updateDraft('t1', (d) => ({ ...d, byQuestionId: { q0: { kind: 'answered', optionIds: ['q0o1'], custom: '' } } }));
    const draft = useAskStore.getState().draftByThread.t1;
    expect(store.beginSubmit('t1', 'tc1')).toBe(true);
    store.finishSubmit('t1', 'tc1', '失败');
    expect(useAskStore.getState().submissionByThread.t1).toEqual({ toolCallId: 'tc1', status: 'error', error: '失败' });
    expect(useAskStore.getState().draftByThread.t1).toBe(draft);
    expect(store.beginSubmit('t1', 'tc1')).toBe(true);
    expect(useAskStore.getState().submissionByThread.t1).toEqual({ toolCallId: 'tc1', status: 'submitting' });
  });

  it('错误身份的 close 和回执不覆盖当前请求，close/open 清理请求状态', () => {
    const store = useAskStore.getState();
    store.open('t1', 'tc1', questions);
    expect(store.beginSubmit('t1', 'tc1')).toBe(true);
    store.finishSubmit('t1', 'tc1', '旧错误');
    expect(useAskStore.getState().submissionByThread.t1?.error).toBe('旧错误');
    store.open('t1', 'tc2', questions);
    expect(useAskStore.getState().submissionByThread.t1).toBeUndefined();
    expect(store.beginSubmit('t1', 'tc2')).toBe(true);
    store.close('t1', 'tc1');
    store.finishSubmit('t1', 'tc1', '迟到的错误');
    expect(useAskStore.getState().submissionByThread.t1).toEqual({ toolCallId: 'tc2', status: 'submitting' });
    store.finishSubmit('t1', 'tc2');
    expect(useAskStore.getState().submissionByThread.t1?.status).toBe('submitted');
    store.close('t1', 'tc2');
    store.finishSubmit('t1', 'tc2', '关闭后的错误');
    expect(useAskStore.getState().submissionByThread.t1).toBeUndefined();
  });
});
