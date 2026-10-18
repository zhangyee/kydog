import { create } from 'zustand';
import type { XResearchTaskSnapshot } from '../../shared/xResearchTask';

// 渲染层的快照池：`xResearch.taskUpdated` 广播与 `xResearch.taskList` 的 resync 都落到这里。
// 键是 `researchRunId`，线程只存在于快照自身 —— 再建一份 threadId → runId 的索引就多出
// 一处需要与它同步的真相。所以按线程的整批操作一律按值里的 `threadId` 过滤。
//
// 卡片要的是另一个分组：一个**回合**一张卡（R81b）。那一层不另存一份状态（那样每个写入点
// 都要记得同时维护两份），而是由 `xResearchTaskGroupKey` / `xResearchTaskSegments` 从池子
// 现算 —— 广播仍按研究到达，只有落到它自己那一格。`reset` / `replaceThread` 因此天然整卡一起清。
export type XResearchTaskStoreState = {
  snapshotsByRunId: Record<string, XResearchTaskSnapshot>;
  upsert: (snapshot: XResearchTaskSnapshot) => void;
  replaceThread: (threadId: string, snapshots: XResearchTaskSnapshot[]) => void;
  reset: (threadId: string) => void;
};

/** 一张卡的分组键（R81b）：创建这段研究的那个回合，**一个回合一张卡**。
 *  旧记录没有 `runId` 时退回它自己的 `researchRunId` —— 一段研究一张卡，与合并前一样，不会空白。 */
export function xResearchTaskGroupKey(snapshot: XResearchTaskSnapshot): string {
  return snapshot.runId ?? snapshot.researchRunId;
}

/** 一张卡的内容：同一个分组键下的研究，按 `createdAt` 升序。
 *  同一毫秒创建的两段按 `researchRunId` 定序 —— 只比 `createdAt` 时它们的先后取决于池子的键序，
 *  同一个池子的两次读取可以给出不同次序（与主进程 `list()` 同一个理由）。 */
export function xResearchTaskSegments(
  snapshotsByRunId: Record<string, XResearchTaskSnapshot>, groupKey: string,
): XResearchTaskSnapshot[] {
  return Object.values(snapshotsByRunId)
    .filter((snapshot) => xResearchTaskGroupKey(snapshot) === groupKey)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)
      || a.researchRunId.localeCompare(b.researchRunId));
}

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
