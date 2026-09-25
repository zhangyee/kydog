import { create } from 'zustand';
import type { RunEvent } from '../../shared/protocol';
import type { ResearchBudget, ResearchUsage, ResearchTaskStatus } from '../../shared/webResearch';

type ProgressPayload = Extract<RunEvent, { topic: 'run.research_progress' }>['payload'];
export type WebResearchProjection = {
  threadId: string;
  runId: string;
  messageId: string;
  toolCallId: string;
  researchRunId: string;
  taskById: Record<string, { status: ResearchTaskStatus; stage: ProgressPayload['stage'] }>;
  budget: ResearchBudget;
  usage: ResearchUsage;
  completed: number;
};

const terminal = new Set<ResearchTaskStatus>(['completed', 'failed', 'cancelled', 'interrupted']);
const maxUsage = (a: ResearchUsage, b: ResearchUsage): ResearchUsage => ({
  candidates: Math.max(a.candidates, b.candidates),
  fetchesDispatched: Math.max(a.fetchesDispatched, b.fetchesDispatched),
  receivedBytes: Math.max(a.receivedBytes, b.receivedBytes),
  modelCalls: Math.max(a.modelCalls, b.modelCalls),
});

type WebResearchState = {
  runs: Record<string, WebResearchProjection>;
  currentRunByThread: Record<string, string>;
  setCurrentRun: (threadId: string, runId: string) => void;
  applyProgress: (payload: ProgressPayload) => void;
  resync: (threadId: string, runId: string) => void;
};

export const useWebResearchStore = create<WebResearchState>((set) => ({
  runs: {},
  currentRunByThread: {},
  setCurrentRun: (threadId, runId) => set((state) => ({
    currentRunByThread: { ...state.currentRunByThread, [threadId]: runId },
  })),
  applyProgress: (payload) => set((state) => {
    const active = state.currentRunByThread[payload.threadId];
    if (active && active !== payload.runId) return state;
    const previous = state.runs[payload.researchRunId];
    const priorTask = previous?.taskById[payload.taskId];
    const status = priorTask && terminal.has(priorTask.status) ? priorTask.status : payload.status;
    const taskById = { ...(previous?.taskById ?? {}), [payload.taskId]: { status,
      stage: priorTask && terminal.has(priorTask.status) ? priorTask.stage : payload.stage } };
    const run: WebResearchProjection = {
      threadId: payload.threadId, runId: payload.runId, messageId: payload.messageId,
      toolCallId: payload.toolCallId, researchRunId: payload.researchRunId, taskById,
      budget: payload.budget,
      usage: previous?.runId === payload.runId ? maxUsage(previous.usage, payload.usage) : payload.usage,
      completed: Object.values(taskById).filter((task) => task.status === 'completed').length,
    };
    return { runs: { ...state.runs, [payload.researchRunId]: run },
      currentRunByThread: { ...state.currentRunByThread, [payload.threadId]: payload.runId } };
  }),
  resync: (threadId, runId) => set((state) => ({
    runs: Object.fromEntries(Object.entries(state.runs).filter(([, run]) =>
      run.threadId !== threadId || run.runId !== runId)),
    currentRunByThread: { ...state.currentRunByThread, [threadId]: runId },
  })),
}));
