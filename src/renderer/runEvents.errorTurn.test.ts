import { describe, it, expect, beforeEach } from 'vitest';
import { applyRunEvent } from './runEvents';
import { useRunsStore } from './stores/runsStore';
import { useThreadsStore } from './stores/threadsStore';

const TID = 'thr-1';
const RID = 'run-1';
const MID = 'thr-1:msg-1';

function resetStores() {
  useRunsStore.setState({ runStateByThread: {}, bufferByMessage: {}, activeThinkingStartByMessage: {} });
  useThreadsStore.setState({ historyByThread: {} });
}

/**
 * 实时路径：以错误结束的一轮（2026-09-14 修的 bug）。
 *
 * provider 在模型说出第一个字之前就拒了请求时，这一轮一个 delta / 工具事件都没有，
 * 渲染层从没建过 buffer。以前 `run.message_end` 到了 `takeBuffer` 拿到 null 就直接
 * return，错误原文只进了线程级的 runState —— 而界面上唯一显示它的地方挂在「助手回复」
 * 组件里，这一轮根本没有回复，于是只剩面包屑上一个「错误」小红点。
 */
describe('实时路径：以错误结束的一轮，错误原文落进这一轮的回复', () => {
  beforeEach(resetStores);

  it('一个字都没输出就失败：没有 buffer 也落一条回复，只含带错误原文的 error 块', () => {
    applyRunEvent({ topic: 'run.started', payload: { threadId: TID, runId: RID } });
    applyRunEvent({
      topic: 'run.message_end',
      payload: { threadId: TID, runId: RID, messageId: MID, errorMessage: '402: {"message":"Insufficient Balance"}' },
    });
    const history = useThreadsStore.getState().historyByThread[TID] ?? [];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: MID, role: 'assistant',
      blocks: [{ kind: 'error', text: '402: {"message":"Insufficient Balance"}' }],
    });
  });

  it('输出了一段之后才失败：error 块排在已经输出的内容之后', () => {
    applyRunEvent({ topic: 'run.started', payload: { threadId: TID, runId: RID } });
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: '我先看看' } });
    applyRunEvent({
      topic: 'run.message_end',
      payload: { threadId: TID, runId: RID, messageId: MID, errorMessage: 'socket hang up' },
    });
    const history = useThreadsStore.getState().historyByThread[TID] ?? [];
    expect(history[0]).toMatchObject({
      role: 'assistant',
      blocks: [{ kind: 'text', text: '我先看看' }, { kind: 'error', text: 'socket hang up' }],
    });
  });

  it('思考到一半就失败：思考块照常收尾成 done，不会一直转圈', () => {
    applyRunEvent({ topic: 'run.started', payload: { threadId: TID, runId: RID } });
    applyRunEvent({ topic: 'run.thinking_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: '先想想' } });
    applyRunEvent({
      topic: 'run.message_end',
      payload: { threadId: TID, runId: RID, messageId: MID, errorMessage: 'socket hang up' },
    });
    const history = useThreadsStore.getState().historyByThread[TID] ?? [];
    expect(history[0]).toMatchObject({
      role: 'assistant',
      blocks: [{ kind: 'thinking', text: '先想想', status: 'done' }, { kind: 'error', text: 'socket hang up' }],
    });
  });
});
