import { create } from 'zustand';
import type { WebResearchTaskSnapshot } from '../../shared/webResearchTask';

type State = { snapshots: Record<string, WebResearchTaskSnapshot>;
  upsert: (snapshot: WebResearchTaskSnapshot) => void };

export const useWebResearchTaskStore = create<State>((set) => ({
  snapshots: {},
  upsert: (snapshot) => set((state) => {
    const prior = state.snapshots[snapshot.researchRunId];
    if (prior && prior.revision > snapshot.revision) return state;
    return { snapshots: { ...state.snapshots, [snapshot.researchRunId]: {
      ...snapshot, browserDomBytes: snapshot.browserDomBytes ?? 0,
      counts: { ...snapshot.counts, browser_queued: snapshot.counts.browser_queued ?? 0,
        browser_reading: snapshot.counts.browser_reading ?? 0, waiting_user: snapshot.counts.waiting_user ?? 0 },
    } } };
  }),
}));
