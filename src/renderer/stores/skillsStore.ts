import { create } from 'zustand';
import type { SkillEntry, ToolEntry } from '../../shared/types';

type Loading = 'idle' | 'loading' | 'ready' | 'error';

type SkillsState = {
  skills: SkillEntry[];
  tools: ToolEntry[];
  loading: Loading;
  error: string | null;
  setSkills: (s: SkillEntry[]) => void;
  setTools: (t: ToolEntry[]) => void;
  setLoading: (l: Loading, err?: string) => void;
};

export const useSkillsStore = create<SkillsState>((set) => ({
  skills: [],
  tools: [],
  loading: 'idle',
  error: null,
  setSkills: (skills) => set({ skills }),
  setTools: (tools) => set({ tools }),
  setLoading: (loading, error) => set({ loading, error: error ?? null }),
}));
