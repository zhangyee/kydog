import { create } from 'zustand';
import type { XResearchTaskSnapshot } from '../../shared/xResearchTask';

// 渲染层的快照池：`xResearch.taskUpdated` 广播与 `xResearch.taskList` 的 resync 都落到这里。
// 键是 `researchRunId`，线程只存在于快照自身 —— 再建一份 threadId → runId 的索引就多出
// 一处需要与它同步的真相。所以按线程的整批操作一律按值里的 `threadId` 过滤。
export type XResearchTaskStoreState = {
  snapshotsByRunId: Record<string, XResearchTaskSnapshot>;
  upsert: (snapshot: XResearchTaskSnapshot) => void;
  replaceThread: (threadId: string, snapshots: XResearchTaskSnapshot[]) => void;
  reset: (threadId: string) => void;
};

function withoutThread(snapshotsByRunId: Record<string, XResearchTaskSnapshot>, threadId: string) {
  return Object.fromEntries(Object.entries(snapshotsByRunId)
    .filter(([, snapshot]) => snapshot.threadId !== threadId));
}

export const useXResearchTaskStore = create<XResearchTaskStoreState>((set) => ({
  snapshotsByRunId: {},
  upsert: (snapshot) => set((state) => {
    const prior = state.snapshotsByRunId[snapshot.researchRunId];
    // 广播与 resync 的响应可以乱序到达：低 revision 的那份是重放/超车，丢掉它，
    // 否则卡片会从「完成」退回「运行中」。
    if (prior && prior.revision > snapshot.revision) return state;
    return { snapshotsByRunId: { ...state.snapshotsByRunId, [snapshot.researchRunId]: snapshot } };
  }),
  // 整批替换而不是合并：resync 拿到的列表就是该线程此刻的全部研究，
  // 合并会把盘上已经不在的那几行永久留在卡上。这里不加 revision 守卫 ——
  // 列表本身是主进程的权威结论，与它比新旧只会让一个过期的守卫挡住正确的一版。
  replaceThread: (threadId, snapshots) => set((state) => ({
    snapshotsByRunId: {
      ...withoutThread(state.snapshotsByRunId, threadId),
      ...Object.fromEntries(snapshots.map((snapshot) => [snapshot.researchRunId, snapshot])),
    },
  })),
  // 换线程时只丢那一个线程的行：别的线程的研究还在主进程里跑，快照要留着。
  reset: (threadId) => set((state) => ({
    snapshotsByRunId: withoutThread(state.snapshotsByRunId, threadId),
  })),
}));
