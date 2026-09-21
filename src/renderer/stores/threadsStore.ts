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
  removeMessage: (threadId: string, messageId: string) => void;
};

/**
 * 渲染层 thread 集合的唯一入口：hydrate / upsertThread / removeThread 都经过这里。
 * 已归档的（archivedAt 有值）在这一处滤掉，别的入口不必各记一遍
 * （spec 2026-09-21-thread-archive-design §3.4）。
 * setThread 不经过这里，但它只原地替换桶里已有的项、不插入新项；归档路径不走它。
 */
function bucketize(threads: Thread[]): Record<string, Thread[]> {
  const out: Record<string, Thread[]> = {};
  for (const t of threads) {
    if (t.archivedAt) continue;
    (out[t.projectPath] ??= []).push(t);
  }
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
    if (!thread.archivedAt) return { threadsByProject: bucketize(flat) };
    // 进来的是一个已归档的：它出桶（bucketize 滤掉）；其 history 一律丢掉（同 removeThread）；正开着的话主区回到 Welcome。
    const { [thread.id]: _drop, ...history } = s.historyByThread;
    return {
      threadsByProject: bucketize(flat),
      historyByThread: history,
      currentThreadId: s.currentThreadId === thread.id ? null : s.currentThreadId,
    };
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
  // 装载 thread.loadHistory 拿回来的那一段历史。
  //
  // 不是「只在缺失时写入」：这次 RPC 在途期间，主进程可能已经把某一轮 flush 成
  // run.message_end 追加进来了（事件与 RPC 结果是两条通道，谁先到没有保证）。
  // 那种情况下直接放弃写入会把整段历史丢掉，直接覆盖又会把追加的那条抹掉。
  // messages 按定义是这条 thread 已落定历史的**前缀**，所以：接在已有内容前面，
  // 按 id 去重。id 来自 normalizePiMessages 的位置编号、是确定性的，因此重复装载幂等
  // （StrictMode 会把这次加载跑两遍）。
  initHistory: (threadId, messages) =>
    set((s) => {
      const existing = s.historyByThread[threadId];
      if (existing === undefined) return { historyByThread: { ...s.historyByThread, [threadId]: messages } };
      const have = new Set(existing.map((m) => m.id));
      const prefix = messages.filter((m) => !have.has(m.id));
      if (prefix.length === 0) return {};
      return { historyByThread: { ...s.historyByThread, [threadId]: [...prefix, ...existing] } };
    }),
  appendUserMessage: (threadId, message) =>
    set((s) => ({
      historyByThread: {
        ...s.historyByThread,
        [threadId]: [...(s.historyByThread[threadId] ?? []), message],
      },
    })),
  /** 发送被拒时撤掉那条乐观写入的用户消息（spec §7）。 */
  removeMessage: (threadId, messageId) =>
    set((s) => {
      const list = s.historyByThread[threadId];
      if (!list) return {};
      return { historyByThread: { ...s.historyByThread, [threadId]: list.filter((m) => m.id !== messageId) } };
    }),
}));

export function getCurrentThread(state: ReturnType<typeof useThreadsStore.getState>): Thread | null {
  if (!state.currentThreadId) return null;
  return Object.values(state.threadsByProject).flat().find((t) => t.id === state.currentThreadId) ?? null;
}
