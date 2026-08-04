import { create } from 'zustand';
import type { AssistantBlock } from '../../shared/types';
import type { AskOutcome, AskQuestion } from '../../shared/askQuestion';

export type RunUiState =
  | { status: 'idle' }
  | { status: 'running'; runId: string }
  | { status: 'error'; error: string };

type Buffer = {
  threadId: string;
  blocks: AssistantBlock[];
  // 协议层并行 groupId 的预登记：message_end 时已知 parallelGroupId，但对应的
  // tool_call block 还要等 tool_execution_start 才会被 addToolCall 加入 blocks。
  // 这里登记 toolCallId → groupId，addToolCall 时回查并落到 block 上。
  pendingParallelGroupByToolId?: Record<string, string>;
};

type RunsState = {
  runStateByThread: Record<string, RunUiState>;
  bufferByMessage: Record<string, Buffer>;
  activeThinkingStartByMessage: Record<string, number | undefined>;
  setRun: (threadId: string, state: RunUiState) => void;
  startMessageBuffer: (threadId: string, messageId: string) => void;
  appendDelta: (messageId: string, delta: string) => void;
  appendThinking: (messageId: string, delta: string) => void;
  addToolCall: (messageId: string, toolCallId: string, name: string, command?: string) => void;
  appendToolChunk: (messageId: string, toolCallId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
  finalizeToolCall: (messageId: string, toolCallId: string, status: 'ok' | 'failed', exitCode?: number) => void;
  markParallelGroup: (messageId: string, toolCallIds: string[], parallelGroupId: string) => void;
  addAskBlock: (messageId: string, toolCallId: string, questions: AskQuestion[]) => void;
  finalizeAskBlock: (messageId: string, toolCallId: string, outcome: AskOutcome) => void;
  takeBuffer: (messageId: string) => AssistantBlock[] | null;
};

export const useRunsStore = create<RunsState>((set, get) => ({
  runStateByThread: {},
  bufferByMessage: {},
  activeThinkingStartByMessage: {},
  setRun: (threadId, state) =>
    set((s) => ({ runStateByThread: { ...s.runStateByThread, [threadId]: state } })),
  startMessageBuffer: (threadId, messageId) =>
    set((s) => ({ bufferByMessage: { ...s.bufferByMessage, [messageId]: { threadId, blocks: [] } } })),
  appendDelta: (messageId, delta) =>
    set((s) => {
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const now = Date.now();
      const blocks = finalizeActiveThinking([...buf.blocks], s.activeThinkingStartByMessage[messageId], now);
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'text') blocks[blocks.length - 1] = { kind: 'text', text: last.text + delta };
      else blocks.push({ kind: 'text', text: delta });
      return {
        activeThinkingStartByMessage: { ...s.activeThinkingStartByMessage, [messageId]: undefined },
        bufferByMessage: { ...s.bufferByMessage, [messageId]: { ...buf, blocks } },
      };
    }),
  appendThinking: (messageId, delta) =>
    set((s) => {
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const now = Date.now();
      const blocks = [...buf.blocks];
      const last = blocks[blocks.length - 1];
      const existingStart = s.activeThinkingStartByMessage[messageId];
      const startedAt = existingStart ?? now;
      if (last && last.kind === 'thinking') {
        blocks[blocks.length - 1] = {
          kind: 'thinking',
          text: last.text + delta,
          status: 'running',
          durationMs: Math.max(0, now - startedAt),
          startedAt: last.startedAt ?? startedAt,
        };
      } else {
        blocks.push({
          kind: 'thinking',
          text: delta,
          status: 'running',
          durationMs: 0,
          startedAt: now,
        });
      }
      return {
        activeThinkingStartByMessage: { ...s.activeThinkingStartByMessage, [messageId]: startedAt },
        bufferByMessage: { ...s.bufferByMessage, [messageId]: { ...buf, blocks } },
      };
    }),
  addToolCall: (messageId, toolCallId, name, command) =>
    set((s) => {
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const now = Date.now();
      const blocks = finalizeActiveThinking([...buf.blocks], s.activeThinkingStartByMessage[messageId], now);
      const pendingGroupId = buf.pendingParallelGroupByToolId?.[toolCallId];
      blocks.push({
        kind: 'tool_call', id: toolCallId, name, command, chunks: [],
        status: 'running', startedAt: now,
        ...(pendingGroupId ? { parallelGroupId: pendingGroupId } : {}),
      });
      return {
        activeThinkingStartByMessage: { ...s.activeThinkingStartByMessage, [messageId]: undefined },
        bufferByMessage: { ...s.bufferByMessage, [messageId]: { ...buf, blocks } },
      };
    }),
  appendToolChunk: (messageId, toolCallId, stream, chunk) =>
    set((s) => {
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const blocks = buf.blocks.map((b) =>
        b.kind === 'tool_call' && b.id === toolCallId
          ? { ...b, chunks: [...b.chunks, { stream, data: chunk }] }
          : b,
      );
      return { bufferByMessage: { ...s.bufferByMessage, [messageId]: { ...buf, blocks } } };
    }),
  finalizeToolCall: (messageId, toolCallId, status, exitCode) =>
    set((s) => {
      const now = Date.now();
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const blocks = buf.blocks.map((b) =>
        b.kind === 'tool_call' && b.id === toolCallId ? { ...b, status, exitCode, endedAt: now } : b,
      );
      return { bufferByMessage: { ...s.bufferByMessage, [messageId]: { ...buf, blocks } } };
    }),
  markParallelGroup: (messageId, toolCallIds, parallelGroupId) =>
    set((s) => {
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const idSet = new Set(toolCallIds);
      // 现有 blocks 直接回填（fixture / 已到达的 tool_call 走这条）
      const blocks = buf.blocks.map((b) =>
        b.kind === 'tool_call' && idSet.has(b.id) ? { ...b, parallelGroupId } : b,
      );
      // 同时登记到 pending，让后续 addToolCall 时也能挂上 groupId
      // （真实 pi：tool_execution_start 在 message_end 之后，所以走 pending 路径）
      const pending = { ...(buf.pendingParallelGroupByToolId ?? {}) };
      for (const id of toolCallIds) pending[id] = parallelGroupId;
      return {
        bufferByMessage: {
          ...s.bufferByMessage,
          [messageId]: { ...buf, blocks, pendingParallelGroupByToolId: pending },
        },
      };
    }),
  addAskBlock: (messageId, toolCallId, questions) =>
    set((s) => {
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const blocks = finalizeActiveThinking([...buf.blocks], s.activeThinkingStartByMessage[messageId], Date.now());
      blocks.push({ kind: 'ask', toolCallId, questions, status: 'pending' });
      return {
        activeThinkingStartByMessage: { ...s.activeThinkingStartByMessage, [messageId]: undefined },
        bufferByMessage: { ...s.bufferByMessage, [messageId]: { ...buf, blocks } },
      };
    }),
  finalizeAskBlock: (messageId, toolCallId, outcome) =>
    set((s) => {
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const blocks = buf.blocks.map((b) => {
        if (b.kind !== 'ask' || b.toolCallId !== toolCallId) return b;
        // answered 必带 answers，其余三态必不带 —— 由 AskBlock 的判别联合保证。
        // 所以非 answered 分支要重建对象而不是 spread，否则 answers 会残留。
        return outcome.kind === 'answered'
          ? { ...b, status: 'answered' as const, answers: outcome.answers }
          : { kind: 'ask' as const, toolCallId: b.toolCallId, questions: b.questions, status: outcome.kind };
      });
      return { bufferByMessage: { ...s.bufferByMessage, [messageId]: { ...buf, blocks } } };
    }),
  takeBuffer: (messageId) => {
    const buf = get().bufferByMessage[messageId];
    if (!buf) return null;
    const now = Date.now();
    const blocks = finalizeActiveThinking(
      [...buf.blocks],
      get().activeThinkingStartByMessage[messageId],
      now,
    );
    set((s) => {
      const { [messageId]: _drop, ...rest } = s.bufferByMessage;
      const { [messageId]: _dropThinking, ...restThinking } = s.activeThinkingStartByMessage;
      return { bufferByMessage: rest, activeThinkingStartByMessage: restThinking };
    });
    return blocks;
  },
}));

function finalizeActiveThinking(blocks: AssistantBlock[], startedAt: number | undefined, now: number): AssistantBlock[] {
  if (!startedAt || blocks.length === 0) return blocks;
  const last = blocks[blocks.length - 1];
  if (last.kind !== 'thinking') return blocks;
  blocks[blocks.length - 1] = {
    kind: 'thinking',
    text: last.text,
    status: 'done',
    durationMs: Math.max(last.durationMs ?? 0, now - startedAt),
    startedAt: last.startedAt ?? startedAt,
    endedAt: now,
  };
  return blocks;
}
