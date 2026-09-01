import { describe, it, expect, beforeEach } from 'vitest';
import { applyRunEvent } from './runEvents';
import { useRunsStore } from './stores/runsStore';
import { useThreadsStore } from './stores/threadsStore';
import type { RunEvent } from '../shared/protocol';
import type { AssistantBlock } from '../shared/types';

const TID = 'thr-1';
const RID = 'run-1';
const MID = 'thr-1:msg-1';
const IDS = ['t1', 't2', 't3', 't4', 't5', 't6'];

function resetStores() {
  useRunsStore.setState({ runStateByThread: {}, bufferByMessage: {}, activeThinkingStartByMessage: {} });
  useThreadsStore.setState({ historyByThread: {} });
}

const started = (): RunEvent => ({ topic: 'run.started', payload: { threadId: TID, runId: RID } });
const thinking = (delta: string): RunEvent =>
  ({ topic: 'run.thinking_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta } });
const group = (): RunEvent =>
  ({ topic: 'run.parallel_group', payload: { threadId: TID, runId: RID, messageId: MID, toolCallIds: IDS, parallelGroupId: 'g1' } });
const toolStart = (id: string): RunEvent =>
  ({ topic: 'run.tool_call_start', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: id, name: 'bash', command: `fastpaper search ${id}` } });
const toolEnd = (id: string): RunEvent =>
  ({ topic: 'run.tool_call_end', payload: { threadId: TID, runId: RID, messageId: MID, toolCallId: id, status: 'ok' } });
const resync = (): RunEvent =>
  ({ topic: 'run.resync', payload: { threadId: TID, runId: RID } });

function toolBlocks(messageId = MID): Array<Extract<AssistantBlock, { kind: 'tool_call' }>> {
  const buf = useRunsStore.getState().bufferByMessage[messageId];
  return (buf?.blocks ?? []).filter((b): b is Extract<AssistantBlock, { kind: 'tool_call' }> => b.kind === 'tool_call');
}

/**
 * 复现单：thread 里发起一组 PARALLEL ×6，趁工具还在跑时重载渲染进程。
 *
 * 重载期间渲染进程根本不存在，那几条 run.tool_call_end 是直接广播丢了的 ——
 * 而且并行批次里 pi 要等整批 settle 才追加 toolResult，所以此刻 pi 的 transcript 上
 * 也看不出终态。唯一还留着这个信号的地方是主进程的 journal，重载后必须靠它接回来。
 */
describe('渲染进程重载后，在途 run 的工具终态', () => {
  beforeEach(resetStores);

  it('重载期间结束的工具，重放之后不再停在「运行中」', () => {
    // 主进程一边广播一边按序留底
    const journal: RunEvent[] = [];
    const emit = (e: RunEvent) => { journal.push(e); applyRunEvent(e); };

    emit(started());
    emit(thinking('先查一批文献…'));
    emit(group());
    for (const id of IDS) emit(toolStart(id));
    expect(toolBlocks().every((b) => b.status === 'running')).toBe(true);

    // ── Ctrl+R：渲染进程没了，store 全丢 ──
    resetStores();

    // 主进程照跑不误：前三个工具在窗口不存在的时候结束了，事件广播出去没人接
    for (const id of IDS.slice(0, 3)) journal.push(toolEnd(id));

    // ── 重载完成，ThreadView 调 thread.loadHistory；主进程同步重放本轮 journal ──
    applyRunEvent(resync());
    for (const e of journal) applyRunEvent(e);

    // 剩下三个在重载之后才结束，走正常直播
    for (const id of IDS.slice(3)) applyRunEvent(toolEnd(id));

    const tools = toolBlocks();
    expect(tools.map((b) => b.id)).toEqual(IDS);
    expect(tools.map((b) => b.status)).toEqual(IDS.map(() => 'ok'));
    // 协议层并行标记也得跟着回来，否则这一组不会再聚合成一张并行卡片
    expect(tools.every((b) => b.parallelGroupId === 'g1')).toBe(true);
    // run 状态也要恢复成「在跑」，不然 composer 会以为可以发下一条
    expect(useRunsStore.getState().runStateByThread[TID]).toEqual({ status: 'running', runId: RID });
  });

  it('重放不会把事件算两遍：run 在飞时没打开的 thread，事件先建了 buffer 也照样收敛', () => {
    const journal: RunEvent[] = [];
    const emit = (e: RunEvent) => { journal.push(e); applyRunEvent(e); };

    // 窗口开着，但用户在别的 thread 上；这些事件照样到达并建了 buffer
    emit(started());
    emit(group());
    for (const id of IDS) emit(toolStart(id));
    for (const id of IDS.slice(0, 2)) emit(toolEnd(id));

    // 用户这才点进来 → loadHistory → resync + 全量重放
    applyRunEvent(resync());
    for (const e of journal) applyRunEvent(e);

    const tools = toolBlocks();
    expect(tools.map((b) => b.id)).toEqual(IDS); // 没有重复的 block
    expect(tools.filter((b) => b.status === 'ok').map((b) => b.id)).toEqual(['t1', 't2']);
  });

  it('本轮结束时 buffer 照常搬进 history，工具终态一并落定', () => {
    const journal: RunEvent[] = [];
    const emit = (e: RunEvent) => { journal.push(e); applyRunEvent(e); };
    emit(started());
    emit(group());
    for (const id of IDS) emit(toolStart(id));

    resetStores();
    for (const id of IDS) journal.push(toolEnd(id));
    applyRunEvent(resync());
    for (const e of journal) applyRunEvent(e);

    applyRunEvent({ topic: 'run.message_end', payload: { threadId: TID, runId: RID, messageId: MID } });
    applyRunEvent({ topic: 'run.ended', payload: { threadId: TID, runId: RID, reason: 'completed' } });

    expect(useRunsStore.getState().bufferByMessage[MID]).toBeUndefined();
    const history = useThreadsStore.getState().historyByThread[TID];
    expect(history).toHaveLength(1);
    const msg = history[0];
    if (msg.role !== 'assistant') throw new Error('expected assistant message');
    const tools = msg.blocks.filter((b): b is Extract<AssistantBlock, { kind: 'tool_call' }> => b.kind === 'tool_call');
    expect(tools.map((b) => b.status)).toEqual(IDS.map(() => 'ok'));
  });
});

/**
 * tool_call 事件按 payload 里的 messageId 归位，不再猜「最近的那个 buffer」。
 * 这两条在旧的近似下是红的：buffer 集合为空时 find 返回 undefined，事件被静默丢弃。
 */
describe('tool_call 事件的归属靠 messageId，不靠猜', () => {
  beforeEach(resetStores);

  it('本轮第一件事就是工具调用（前面没有文字或思考）时，卡片照样出现', () => {
    applyRunEvent(started());
    applyRunEvent(toolStart('t1'));
    applyRunEvent(toolEnd('t1'));

    const tools = toolBlocks();
    expect(tools.map((b) => b.id)).toEqual(['t1']);
    expect(tools[0].status).toBe('ok');
  });

  it('本轮张口就是一批并行工具时，parallelGroupId 照样登记得上', () => {
    // run.parallel_group 来自 pi 的 message_end，比批次里任何 tool_execution_start 都早；
    // 前面又没有 delta，所以这条事件到达时 buffer 还不存在。
    applyRunEvent(started());
    applyRunEvent(group());
    for (const id of IDS) applyRunEvent(toolStart(id));

    expect(toolBlocks().map((b) => b.parallelGroupId)).toEqual(IDS.map(() => 'g1'));
  });

  it('同一条 thread 上有更晚的 buffer 时，工具仍落在自己那一轮上', () => {
    const older = 'thr-1:msg-0';
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: older, delta: '上一轮' } });
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: '这一轮' } });
    // 事件属于 older 那一轮，而它不是「最近的那个 buffer」
    applyRunEvent({ topic: 'run.tool_call_start', payload: { threadId: TID, runId: RID, messageId: older, toolCallId: 't1', name: 'bash', command: 'ls' } });

    expect(toolBlocks(older).map((b) => b.id)).toEqual(['t1']);
    expect(toolBlocks(MID)).toEqual([]);
  });
});

describe('initHistory 与直播追加的先后', () => {
  beforeEach(resetStores);

  it('RPC 在途期间 run.message_end 先落地时，历史前缀不会被丢掉', () => {
    // loadHistory 的结果还在路上，主进程先把本轮 flush 了
    applyRunEvent({ topic: 'run.message_delta', payload: { threadId: TID, runId: RID, messageId: MID, delta: '好的' } });
    applyRunEvent({ topic: 'run.message_end', payload: { threadId: TID, runId: RID, messageId: MID } });
    expect(useThreadsStore.getState().historyByThread[TID]).toHaveLength(1);

    // 这才轮到 RPC 结果：它带的是这条 thread 已落定历史的前缀
    useThreadsStore.getState().initHistory(TID, [
      { id: `${TID}#0`, role: 'user', createdAt: 'x', content: '帮我查一下' },
    ]);

    const history = useThreadsStore.getState().historyByThread[TID];
    expect(history.map((m) => m.id)).toEqual([`${TID}#0`, MID]);
  });

  it('同一段历史装载两次是幂等的（StrictMode 会跑两遍）', () => {
    const msgs = [
      { id: `${TID}#0`, role: 'user' as const, createdAt: 'x', content: 'a' },
      { id: `${TID}#1`, role: 'user' as const, createdAt: 'x', content: 'b' },
    ];
    useThreadsStore.getState().initHistory(TID, msgs);
    useThreadsStore.getState().initHistory(TID, msgs);
    expect(useThreadsStore.getState().historyByThread[TID]).toHaveLength(2);
  });
});
