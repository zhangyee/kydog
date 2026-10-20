import { create } from 'zustand';
import { initDraft, type AskDraft } from '../panels/main-pane/askDraft';
import type { AskQuestion } from '../../shared/askQuestion';

type Pending = { toolCallId: string; questions: AskQuestion[] };

type Submission = { toolCallId: string; status: 'submitting' | 'submitted' | 'error'; error?: string };

type AskState = {
  pendingByThread: Record<string, Pending | undefined>;
  draftByThread: Record<string, AskDraft | undefined>;
  submissionByThread: Record<string, Submission | undefined>;
  beginSubmit: (threadId: string, toolCallId: string) => boolean;
  finishSubmit: (threadId: string, toolCallId: string, error?: string) => void;
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
  submissionByThread: {},

  open: (threadId, toolCallId, questions) =>
    set((s) => ({
      pendingByThread: { ...s.pendingByThread, [threadId]: { toolCallId, questions } },
      draftByThread: { ...s.draftByThread, [threadId]: initDraft() },
      submissionByThread: { ...s.submissionByThread, [threadId]: undefined },
    })),

  close: (threadId, toolCallId) =>
    set((s) => {
      if (s.pendingByThread[threadId]?.toolCallId !== toolCallId) return {};
      const { [threadId]: _p, ...pending } = s.pendingByThread;
      const { [threadId]: _d, ...drafts } = s.draftByThread;
      const { [threadId]: _s, ...submissions } = s.submissionByThread;
      return { pendingByThread: pending, draftByThread: drafts, submissionByThread: submissions };
    }),

  beginSubmit: (threadId, toolCallId) => {
    let began = false;
    set((s) => {
      if (s.pendingByThread[threadId]?.toolCallId !== toolCallId) return {};
      const status = s.submissionByThread[threadId]?.status;
      if (status === 'submitting' || status === 'submitted') return {};
      began = true;
      return { submissionByThread: { ...s.submissionByThread, [threadId]: { toolCallId, status: 'submitting' } } };
    });
    return began;
  },

  finishSubmit: (threadId, toolCallId, error) =>
    set((s) => {
      if (s.pendingByThread[threadId]?.toolCallId !== toolCallId ||
          s.submissionByThread[threadId]?.toolCallId !== toolCallId ||
          s.submissionByThread[threadId]?.status !== 'submitting') return {};
      return {
        submissionByThread: {
          ...s.submissionByThread,
          [threadId]: error === undefined ? { toolCallId, status: 'submitted' } : { toolCallId, status: 'error', error },
        },
      };
    }),

  updateDraft: (threadId, fn) =>
    set((s) => {
      const cur = s.draftByThread[threadId];
      if (!cur) return {};
      return { draftByThread: { ...s.draftByThread, [threadId]: fn(cur) } };
    }),
}));
