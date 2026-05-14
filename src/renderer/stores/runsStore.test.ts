import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRunsStore } from './runsStore';

const MID = 'msg-1';
const TID = 'thr-1';

function reset() {
  useRunsStore.setState({
    runStateByThread: {},
    bufferByMessage: {},
    activeThinkingStartByMessage: {},
  });
}

describe('runsStore 时间戳写入', () => {
  beforeEach(() => {
    reset();
  });

  it('thinking block 首次 append 时填 startedAt', () => {
    const fake = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fake);
    const s = useRunsStore.getState();
    s.startMessageBuffer(TID, MID);
    s.appendThinking(MID, 'hello');
    const block = useRunsStore.getState().bufferByMessage[MID].blocks[0];
    expect(block.kind).toBe('thinking');
    if (block.kind === 'thinking') expect(block.startedAt).toBe(fake);
    vi.restoreAllMocks();
  });

  it('thinking block 后续 delta 不改 startedAt', () => {
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_001_500;
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValueOnce(t1);
    spy.mockReturnValueOnce(t2);
    const s = useRunsStore.getState();
    s.startMessageBuffer(TID, MID);
    s.appendThinking(MID, 'a');
    s.appendThinking(MID, 'b');
    const block = useRunsStore.getState().bufferByMessage[MID].blocks[0];
    if (block.kind === 'thinking') expect(block.startedAt).toBe(t1);
    vi.restoreAllMocks();
  });

  it('takeBuffer 时 finalize thinking 写入 endedAt', () => {
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_005_000;
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValueOnce(t1);
    spy.mockReturnValueOnce(t2);
    const s = useRunsStore.getState();
    s.startMessageBuffer(TID, MID);
    s.appendThinking(MID, 'a');
    const blocks = s.takeBuffer(MID);
    expect(blocks).not.toBeNull();
    const tb = blocks![0];
    if (tb.kind === 'thinking') {
      expect(tb.startedAt).toBe(t1);
      expect(tb.endedAt).toBe(t2);
      expect(tb.status).toBe('done');
    }
    vi.restoreAllMocks();
  });

  it('addToolCall 写 startedAt; finalizeToolCall 写 endedAt', () => {
    const t1 = 1_700_000_010_000;
    const t2 = 1_700_000_012_000;
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValueOnce(t1);
    spy.mockReturnValueOnce(t2);
    const s = useRunsStore.getState();
    s.startMessageBuffer(TID, MID);
    s.addToolCall(MID, 'tc-1', 'bash', 'ls');
    let block = useRunsStore.getState().bufferByMessage[MID].blocks[0];
    if (block.kind === 'tool_call') expect(block.startedAt).toBe(t1);
    s.finalizeToolCall(MID, 'tc-1', 'ok');
    block = useRunsStore.getState().bufferByMessage[MID].blocks[0];
    if (block.kind === 'tool_call') {
      expect(block.startedAt).toBe(t1);
      expect(block.endedAt).toBe(t2);
    }
    vi.restoreAllMocks();
  });

  it('text delta 之后再 addToolCall：finalize 前一个 thinking 时也写 endedAt', () => {
    const t1 = 1_700_000_020_000;
    const t2 = 1_700_000_022_000;
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValueOnce(t1);
    spy.mockReturnValueOnce(t2);
    const s = useRunsStore.getState();
    s.startMessageBuffer(TID, MID);
    s.appendThinking(MID, 'think');
    s.addToolCall(MID, 'tc-2', 'bash', 'echo');
    const blocks = useRunsStore.getState().bufferByMessage[MID].blocks;
    expect(blocks).toHaveLength(2);
    const th = blocks[0];
    if (th.kind === 'thinking') {
      expect(th.startedAt).toBe(t1);
      expect(th.endedAt).toBe(t2);
      expect(th.status).toBe('done');
    }
    vi.restoreAllMocks();
  });

  it('addToolCall 后 appendThinking 得到新 startedAt，而非复用上一段', () => {
    const t1 = 1_700_000_030_000;
    const t2 = 1_700_000_031_000;
    const t3 = 1_700_000_032_500;
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValueOnce(t1); // appendThinking('a')
    spy.mockReturnValueOnce(t2); // addToolCall（触发 finalizeActiveThinking）
    spy.mockReturnValueOnce(t3); // appendThinking('b')
    const s = useRunsStore.getState();
    s.startMessageBuffer(TID, MID);
    s.appendThinking(MID, 'a');
    s.addToolCall(MID, 'tc-1', 'bash', 'ls');
    s.appendThinking(MID, 'b');
    const blocks = useRunsStore.getState().bufferByMessage[MID].blocks;
    expect(blocks).toHaveLength(3); // [thinking(done), tool_call, thinking(running)]
    const second = blocks[2];
    expect(second.kind).toBe('thinking');
    if (second.kind === 'thinking') {
      expect(second.startedAt).toBe(t3);
      expect(second.startedAt).not.toBe(t1);
    }
    vi.restoreAllMocks();
  });

  it('markParallelGroup 回填 parallelGroupId 到指定 tool_call blocks', () => {
    const s = useRunsStore.getState();
    s.startMessageBuffer(TID, MID);
    s.addToolCall(MID, 'tc-a', 'bash', 'fastpaper a');
    s.addToolCall(MID, 'tc-b', 'bash', 'fastpaper b');
    s.addToolCall(MID, 'tc-c', 'bash', 'ls');
    s.markParallelGroup(MID, ['tc-a', 'tc-b'], 'g-1');
    const blocks = useRunsStore.getState().bufferByMessage[MID].blocks;
    const findTool = (id: string) => blocks.find(b => b.kind === 'tool_call' && b.id === id);
    const a = findTool('tc-a'); const b = findTool('tc-b'); const c = findTool('tc-c');
    if (a?.kind === 'tool_call') expect(a.parallelGroupId).toBe('g-1');
    if (b?.kind === 'tool_call') expect(b.parallelGroupId).toBe('g-1');
    if (c?.kind === 'tool_call') expect(c.parallelGroupId).toBeUndefined();
  });

  it('markParallelGroup 找不到对应 messageId：no-op，不抛错', () => {
    const before = useRunsStore.getState().bufferByMessage;
    useRunsStore.getState().markParallelGroup('ghost', ['x', 'y'], 'g-1');
    expect(useRunsStore.getState().bufferByMessage).toBe(before);
  });
});
