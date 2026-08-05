import { describe, it, expect } from 'vitest';
import { createAskBatchExtension } from './askBatchExtension';
import { BATCH_BLOCK_REASON } from './askBatchGuard';
import { ASK_TOOL_NAME } from '../../shared/askQuestion';

function wire() {
  const { guard, factory } = createAskBatchExtension();
  const handlers = new Map<string, Array<(e: unknown) => unknown>>();
  factory({ on: (evt, h) => { handlers.set(evt, [...(handlers.get(evt) ?? []), h]); } });
  const fire = (evt: string, payload: unknown) =>
    (handlers.get(evt) ?? []).map((h) => h(payload));
  const batch = (calls: Array<{ id: string; name: string }>) =>
    fire('message_end', { message: { role: 'assistant', content: calls.map((c) => ({ type: 'toolCall', ...c })) } });
  return { guard, fire, batch };
}

describe('createAskBatchExtension', () => {
  it('混合批次里每一个调用都被 block，理由是给模型看的那句', () => {
    const { fire, batch } = wire();
    batch([{ id: 'w1', name: 'write' }, { id: 'a1', name: ASK_TOOL_NAME }]);
    expect(fire('tool_call', { toolCallId: 'w1' })[0]).toEqual({ block: true, reason: BATCH_BLOCK_REASON });
    expect(fire('tool_call', { toolCallId: 'a1' })[0]).toEqual({ block: true, reason: BATCH_BLOCK_REASON });
  });

  it('合法的单 ask 批次放行（返回 undefined 而不是 block:false）', () => {
    const { fire, batch } = wire();
    batch([{ id: 'a1', name: ASK_TOOL_NAME }]);
    expect(fire('tool_call', { toolCallId: 'a1' })[0]).toBeUndefined();
  });

  it('两个 ask 同批整体被拦', () => {
    const { fire, batch } = wire();
    batch([{ id: 'a1', name: ASK_TOOL_NAME }, { id: 'a2', name: ASK_TOOL_NAME }]);
    expect(fire('tool_call', { toolCallId: 'a1' })[0]).toMatchObject({ block: true });
    expect(fire('tool_call', { toolCallId: 'a2' })[0]).toMatchObject({ block: true });
  });

  it('上一批的非法 id 不污染下一批', () => {
    const { fire, batch, guard } = wire();
    batch([{ id: 'w1', name: 'write' }, { id: 'a1', name: ASK_TOOL_NAME }]);
    batch([{ id: 'a2', name: ASK_TOOL_NAME }]);
    expect(fire('tool_call', { toolCallId: 'a2' })[0]).toBeUndefined();
    expect(guard.shouldBlock('w1')).toBe(false);
  });

  it('非 assistant 的 message_end 不改变集合', () => {
    const { fire, batch, guard } = wire();
    batch([{ id: 'w1', name: 'write' }, { id: 'a1', name: ASK_TOOL_NAME }]);
    fire('message_end', { message: { role: 'toolResult', content: [] } });
    expect(guard.shouldBlock('w1')).toBe(true);
  });

  it('agent_end 清空集合', () => {
    const { fire, batch, guard } = wire();
    batch([{ id: 'w1', name: 'write' }, { id: 'a1', name: ASK_TOOL_NAME }]);
    fire('agent_end', {});
    expect(guard.shouldBlock('w1')).toBe(false);
  });

  it('没有 toolCallId 的 tool_call 事件不炸', () => {
    const { fire, batch } = wire();
    batch([{ id: 'w1', name: 'write' }, { id: 'a1', name: ASK_TOOL_NAME }]);
    expect(() => fire('tool_call', {})).not.toThrow();
    expect(fire('tool_call', {})[0]).toBeUndefined();
  });
});
