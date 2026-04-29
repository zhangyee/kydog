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
  setProject: (project: Project) => void;
  setThread: (thread: Thread) => void;
  removeProject: (path: string) => void;
  setHistory: (threadId: string, messages: Message[]) => void;
  initHistory: (threadId: string, messages: Message[]) => void;
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
  setProject: (project) => set((s) => ({
    projects: s.projects.map((p) => p.path === project.path ? project : p),
  })),
  setThread: (thread) => set((s) => {
    const bucket = s.threadsByProject[thread.projectPath] ?? [];
    const next = bucket.map((t) => t.id === thread.id ? thread : t);
    return { threadsByProject: { ...s.threadsByProject, [thread.projectPath]: next } };
  }),
  removeProject: (path) => set((s) => {
    const projects = s.projects.filter((p) => p.path !== path);
    const removedThreadIds = new Set((s.threadsByProject[path] ?? []).map((t) => t.id));
    const threadsByProject = { ...s.threadsByProject };
    delete threadsByProject[path];
    const historyByThread = Object.fromEntries(
      Object.entries(s.historyByThread).filter(([id]) => !removedThreadIds.has(id))
    );
    return {
      projects,
      threadsByProject,
      historyByThread,
      currentThreadId: s.currentThreadId && removedThreadIds.has(s.currentThreadId) ? null : s.currentThreadId,
    };
  }),
  setHistory: (threadId, messages) =>
    set((s) => ({ historyByThread: { ...s.historyByThread, [threadId]: messages } })),
  initHistory: (threadId, messages) =>
    set((s) => s.historyByThread[threadId] !== undefined ? {} : { historyByThread: { ...s.historyByThread, [threadId]: messages } }),
  appendUserMessage: (threadId, message) =>
    set((s) => ({
      historyByThread: {
        ...s.historyByThread,
        [threadId]: [...(s.historyByThread[threadId] ?? []), message],
      },
    })),
}));
