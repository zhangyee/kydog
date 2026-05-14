import { create } from 'zustand';
import type { AssistantBlock } from '../../shared/types';

export type RunUiState =
  | { status: 'idle' }
  | { status: 'running'; runId: string }
  | { status: 'error'; error: string };

type RunsState = {
  runStateByThread: Record<string, RunUiState>;
  bufferByMessage: Record<string, { threadId: string; blocks: AssistantBlock[] }>;
  activeThinkingStartByMessage: Record<string, number | undefined>;
  setRun: (threadId: string, state: RunUiState) => void;
  startMessageBuffer: (threadId: string, messageId: string) => void;
  appendDelta: (messageId: string, delta: string) => void;
  appendThinking: (messageId: string, delta: string) => void;
  addToolCall: (messageId: string, toolCallId: string, name: string, command?: string) => void;
  appendToolChunk: (messageId: string, toolCallId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
  finalizeToolCall: (messageId: string, toolCallId: string, status: 'ok' | 'failed', exitCode?: number) => void;
  markParallelGroup: (messageId: string, toolCallIds: string[], parallelGroupId: string) => void;
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
      return {
        activeThinkingStartByMessage: { ...s.activeThinkingStartByMessage, [messageId]: undefined },
        bufferByMessage: {
          ...s.bufferByMessage,
          [messageId]: {
            ...buf,
            blocks: [
              ...blocks,
              { kind: 'tool_call', id: toolCallId, name, command, chunks: [], status: 'running', startedAt: now },
            ],
          },
        },
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
      const blocks = buf.blocks.map((b) =>
        b.kind === 'tool_call' && idSet.has(b.id) ? { ...b, parallelGroupId } : b,
      );
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
