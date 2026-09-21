import { create } from 'zustand';
import type { Project, Thread, Message } from '../../shared/types';

type ThreadsState = {
  projects: Project[];
  threadsByProject: Record<string, Thread[]>;
  currentThreadId: string | null;
  /**
   * 用户最近一次明确指向的项目 —— 「新对话」按钮 / ⌘N / 欢迎页把对话建在这里
   * （读它走 newThreadProjectPath）。**只由明确动作写入，不按时间戳推测**：
   *  · selectThread —— 选中一条对话（含重启后恢复选中）→ 它所在的项目；
   *  · upsertThread —— 当前对话的 projectPath 变了（输入框的项目下拉）→ 新项目；
   *  · addProject —— 打开项目 → 该项目；
   *  · removeProject —— 关掉的正是它 → null。
   * 只看「当前对话在哪个项目」不够：2026-09-21 刚打开 LLM、3 秒后点新对话，那一刻选中的
   * 还是 cqcai 的对话。点项目行展开 / 折叠不算（常常只是看一眼）。
   */
  focusedProjectPath: string | null;
  historyByThread: Record<string, Message[]>;
  hydrate: (projects: Project[], threads: Thread[]) => void;
  selectThread: (threadId: string | null) => void;
  /** 打开项目之后放进列表（已在就挪到末尾，同改动前各入口的写法），并让它成为当前项目。 */
  addProject: (project: Project) => void;
  upsertThread: (thread: Thread) => void;
  removeThread: (threadId: string) => void;
  setProject: (project: Project) => void;
  setThread: (thread: Thread) => void;
  removeProject: (path: string) => void;
  setHistory: (threadId: string, messages: Message[]) => void;
  initHistory: (threadId: string, messages: Message[]) => void;
  appendUserMessage: (threadId: string, message: Message) => void;
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

function findThread(threadsByProject: Record<string, Thread[]>, threadId: string): Thread | undefined {
  return Object.values(threadsByProject).flat().find((t) => t.id === threadId);
}

export const useThreadsStore = create<ThreadsState>((set) => ({
  projects: [],
  threadsByProject: {},
  currentThreadId: null,
  focusedProjectPath: null,
  historyByThread: {},
  hydrate: (projects, threads) => set({ projects, threadsByProject: bucketize(threads) }),
  selectThread: (threadId) => set((s) => {
    const thread = threadId ? findThread(s.threadsByProject, threadId) : undefined;
    return thread
      ? { currentThreadId: threadId, focusedProjectPath: thread.projectPath }
      : { currentThreadId: threadId };
  }),
  addProject: (project) => set((s) => ({
    projects: [...s.projects.filter((p) => p.path !== project.path), project],
    focusedProjectPath: project.path,
  })),
  upsertThread: (thread) => set((s) => {
    const prev = findThread(s.threadsByProject, thread.id);
    const flat = Object.values(s.threadsByProject).flat().filter(t => t.id !== thread.id);
    flat.push(thread);
    if (!thread.archivedAt) {
      // 只认「当前对话的项目变了」：标题生成之类把当前对话推回来时不许把焦点抢回去。
      const moved = thread.id === s.currentThreadId && prev !== undefined && prev.projectPath !== thread.projectPath;
      return moved
        ? { threadsByProject: bucketize(flat), focusedProjectPath: thread.projectPath }
        : { threadsByProject: bucketize(flat) };
    }
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
      focusedProjectPath: s.focusedProjectPath === path ? null : s.focusedProjectPath,
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
}));

export function getCurrentThread(state: ReturnType<typeof useThreadsStore.getState>): Thread | null {
  if (!state.currentThreadId) return null;
  return findThread(state.threadsByProject, state.currentThreadId) ?? null;
}

/** 「新对话」建在哪个项目：当前项目（见 focusedProjectPath），没有就第一个项目；一个项目都没有是 null。 */
export function newThreadProjectPath(state: ReturnType<typeof useThreadsStore.getState>): string | null {
  return state.focusedProjectPath ?? state.projects[0]?.path ?? null;
}
