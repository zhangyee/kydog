import { create } from 'zustand';
import type { AssistantBlock } from '../../shared/types';

export type RunUiState =
  | { status: 'idle' }
  | { status: 'running'; runId: string }
  | { status: 'error'; error: string };

type RunsState = {
  runStateByThread: Record<string, RunUiState>;
  bufferByMessage: Record<string, { threadId: string; blocks: AssistantBlock[] }>;
  setRun: (threadId: string, state: RunUiState) => void;
  startMessageBuffer: (threadId: string, messageId: string) => void;
  appendDelta: (messageId: string, delta: string) => void;
  appendThinking: (messageId: string, delta: string) => void;
  addToolCall: (messageId: string, toolCallId: string, name: string, command?: string) => void;
  appendToolChunk: (messageId: string, toolCallId: string, stream: 'stdout' | 'stderr', chunk: string) => void;
  finalizeToolCall: (messageId: string, toolCallId: string, status: 'ok' | 'failed', exitCode?: number) => void;
  takeBuffer: (messageId: string) => AssistantBlock[] | null;
};

export const useRunsStore = create<RunsState>((set, get) => ({
  runStateByThread: {},
  bufferByMessage: {},
  setRun: (threadId, state) =>
    set((s) => ({ runStateByThread: { ...s.runStateByThread, [threadId]: state } })),
  startMessageBuffer: (threadId, messageId) =>
    set((s) => ({ bufferByMessage: { ...s.bufferByMessage, [messageId]: { threadId, blocks: [] } } })),
  appendDelta: (messageId, delta) =>
    set((s) => {
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const blocks = [...buf.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'text') blocks[blocks.length - 1] = { kind: 'text', text: last.text + delta };
      else blocks.push({ kind: 'text', text: delta });
      return { bufferByMessage: { ...s.bufferByMessage, [messageId]: { ...buf, blocks } } };
    }),
  appendThinking: (messageId, delta) =>
    set((s) => {
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const blocks = [...buf.blocks];
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'thinking') blocks[blocks.length - 1] = { kind: 'thinking', text: last.text + delta };
      else blocks.push({ kind: 'thinking', text: delta });
      return { bufferByMessage: { ...s.bufferByMessage, [messageId]: { ...buf, blocks } } };
    }),
  addToolCall: (messageId, toolCallId, name, command) =>
    set((s) => {
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      return {
        bufferByMessage: {
          ...s.bufferByMessage,
          [messageId]: {
            ...buf,
            blocks: [...buf.blocks, { kind: 'tool_call', id: toolCallId, name, command, chunks: [], status: 'running' }],
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
      const buf = s.bufferByMessage[messageId];
      if (!buf) return {};
      const blocks = buf.blocks.map((b) =>
        b.kind === 'tool_call' && b.id === toolCallId ? { ...b, status, exitCode } : b,
      );
      return { bufferByMessage: { ...s.bufferByMessage, [messageId]: { ...buf, blocks } } };
    }),
  takeBuffer: (messageId) => {
    const buf = get().bufferByMessage[messageId];
    if (!buf) return null;
    set((s) => {
      const { [messageId]: _drop, ...rest } = s.bufferByMessage;
      return { bufferByMessage: rest };
    });
    return buf.blocks;
  },
}));
