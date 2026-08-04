import { create } from 'zustand';
import { initDraft, type AskDraft } from '../panels/main-pane/askDraft';
import type { AskQuestion } from '../../shared/askQuestion';

type Pending = { toolCallId: string; questions: AskQuestion[] };

type AskState = {
  pendingByThread: Record<string, Pending | undefined>;
  draftByThread: Record<string, AskDraft | undefined>;
  open: (threadId: string, toolCallId: string, questions: AskQuestion[]) => void;
  close: (threadId: string, toolCallId: string) => void;
  updateDraft: (threadId: string, fn: (d: AskDraft) => AskDraft) => void;
};

/**
 * pending 按 thread 存：用户切走再切回来，卡片和草稿都还在。
 * 同一 thread 同一时刻至多一个 pending（sequential + 批次独占保证）。
 */
export const useAskStore = create<AskState>((set) => ({
  pendingByThread: {},
  draftByThread: {},

  open: (threadId, toolCallId, questions) =>
    set((s) => ({
      pendingByThread: { ...s.pendingByThread, [threadId]: { toolCallId, questions } },
      draftByThread: { ...s.draftByThread, [threadId]: initDraft() },
    })),

  close: (threadId, toolCallId) =>
    set((s) => {
      if (s.pendingByThread[threadId]?.toolCallId !== toolCallId) return {};
      const { [threadId]: _p, ...pending } = s.pendingByThread;
      const { [threadId]: _d, ...drafts } = s.draftByThread;
      return { pendingByThread: pending, draftByThread: drafts };
    }),

  updateDraft: (threadId, fn) =>
    set((s) => {
      const cur = s.draftByThread[threadId];
      if (!cur) return {};
      return { draftByThread: { ...s.draftByThread, [threadId]: fn(cur) } };
    }),
}));
