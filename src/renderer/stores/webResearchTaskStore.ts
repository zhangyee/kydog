import { create } from 'zustand';
import type { WebResearchTaskSnapshot } from '../../shared/webResearchTask';

type State = { snapshots: Record<string, WebResearchTaskSnapshot>;
  upsert: (snapshot: WebResearchTaskSnapshot) => void };

export const useWebResearchTaskStore = create<State>((set) => ({
  snapshots: {},
  upsert: (snapshot) => set((state) => {
    const prior = state.snapshots[snapshot.researchRunId];
    if (prior && prior.revision > snapshot.revision) return state;
    return { snapshots: { ...state.snapshots, [snapshot.researchRunId]: snapshot } };
  }),
}));
