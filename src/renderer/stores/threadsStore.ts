import { create } from 'zustand';
import type { Project, Thread, Message } from '../../shared/types';

type ThreadsState = {
  projects: Project[];
  threadsByProject: Record<string, Thread[]>;
  currentThreadId: string | null;
  historyByThread: Record<string, Message[]>;
  hydrate: (projects: Project[], threads: Thread[]) => void;
  selectThread: (threadId: string | null) => void;
  upsertThread: (thread: Thread) => void;
  removeThread: (threadId: string) => void;
  setHistory: (threadId: string, messages: Message[]) => void;
  appendUserMessage: (threadId: string, message: Message) => void;
};

function bucketize(threads: Thread[]): Record<string, Thread[]> {
  const out: Record<string, Thread[]> = {};
  for (const t of threads) (out[t.projectPath] ??= []).push(t);
  for (const k of Object.keys(out)) out[k].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return out;
}

export const useThreadsStore = create<ThreadsState>((set) => ({
  projects: [],
  threadsByProject: {},
  currentThreadId: null,
  historyByThread: {},
  hydrate: (projects, threads) => set({ projects, threadsByProject: bucketize(threads) }),
  selectThread: (threadId) => set({ currentThreadId: threadId }),
  upsertThread: (thread) => set((s) => {
    const flat = Object.values(s.threadsByProject).flat().filter(t => t.id !== thread.id);
    flat.push(thread);
    return { threadsByProject: bucketize(flat) };
  }),
  removeThread: (threadId) => set((s) => {
    const flat = Object.values(s.threadsByProject).flat().filter(t => t.id !== threadId);
    const { [threadId]: _drop, ...history } = s.historyByThread;
    return {
      threadsByProject: bucketize(flat),
      historyByThread: history,
      currentThreadId: s.currentThreadId === threadId ? null : s.currentThreadId,
    };
  }),
  setHistory: (threadId, messages) =>
    set((s) => ({ historyByThread: { ...s.historyByThread, [threadId]: messages } })),
  appendUserMessage: (threadId, message) =>
    set((s) => ({
      historyByThread: {
        ...s.historyByThread,
        [threadId]: [...(s.historyByThread[threadId] ?? []), message],
      },
    })),
}));
