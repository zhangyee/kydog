// src/renderer/stores/llmStore.ts
import { create } from 'zustand';
import type { LlmListResult, LlmConfiguredEntry } from '../../shared/protocol';

type LlmState = {
  catalog: LlmListResult['catalog'];
  configured: LlmConfiguredEntry[];
  customProviders: LlmListResult['customProviders'];
  defaultProvider: string | null;
  defaultModel: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setSnapshot: (s: LlmListResult) => void;
};

export const useLlmStore = create<LlmState>((set) => ({
  catalog: [],
  configured: [],
  customProviders: [],
  defaultProvider: null,
  defaultModel: null,
  loading: false,
  setSnapshot: (s) => set({
    catalog: s.catalog,
    configured: s.configured,
    customProviders: s.customProviders,
    defaultProvider: s.defaultProvider,
    defaultModel: s.defaultModel,
    loading: false,
  }),
  refresh: async () => {
    set({ loading: true });
    const r = await window.kydog.invoke('llm.list');
    set({
      catalog: r.catalog, configured: r.configured, customProviders: r.customProviders,
      defaultProvider: r.defaultProvider, defaultModel: r.defaultModel, loading: false,
    });
  },
}));
