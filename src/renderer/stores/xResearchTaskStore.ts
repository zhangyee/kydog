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
  // 合并会把盘上已经不在的那几行永久留在卡上。
  // 但这份列表可能是更早时刻算出来的（`list()` → `open()` 要读盘，期间广播一直在推 revision），
  // 所以落每条之前先比一次 revision：低于手里那份的是过期重放，保留手里那份。
  // `upsert` 的守卫在这里帮不上忙 —— 这一支是先按线程删、再把列表整个铺回去，没有「已有行」可挡。
  replaceThread: (threadId, snapshots) => set((state) => {
    const incoming: [string, XResearchTaskSnapshot][] = snapshots.map((snapshot) => {
      const prior = state.snapshotsByRunId[snapshot.researchRunId];
      // 相等时放行，与 `upsert` 一致。
      return [snapshot.researchRunId, prior && prior.revision > snapshot.revision ? prior : snapshot];
    });
    return {
      snapshotsByRunId: {
        ...withoutThread(state.snapshotsByRunId, threadId),
        ...Object.fromEntries(incoming),
      },
    };
  }),
  // 换线程时只丢那一个线程的行：别的线程的研究还在主进程里跑，快照要留着。
  reset: (threadId) => set((state) => ({
    snapshotsByRunId: withoutThread(state.snapshotsByRunId, threadId),
  })),
}));
