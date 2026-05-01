import { create } from 'zustand';
import type { FsNode, ThemeName } from '../../shared/types';

export type SettingsTabId = 'provider' | 'donate' | 'about' | 'skills';
type CenterTabKind = 'thread' | 'settings';

type UiState = {
  theme: ThemeName;
  workspaceCollapsed: boolean;
  inspectorCollapsed: boolean;
  workspaceWidth: number;
  inspectorWidth: number;
  userMenuOpen: boolean;
  settingsTabOpen: boolean;
  settingsTab: SettingsTabId;
  settingsDetailProviderId: string | null;
  openSettingsDetail: (providerId: string) => void;
  closeSettingsDetail: () => void;
  settingsAddProviderOpen: boolean;
  openSettingsAddProvider: () => void;
  closeSettingsAddProvider: () => void;
  activeCenterTab: CenterTabKind;
  expandedDirs: Set<string>;
  expandedProjects: Set<string>;
  dirCache: Record<string, FsNode[]>;
  projectsGroupBy: 'project' | 'time';
  projectsSortBy: 'created' | 'updated';
  setProjectsGroupBy: (g: 'project' | 'time') => void;
  setProjectsSortBy: (s: 'created' | 'updated') => void;
  collapseAllProjects: () => void;
  setTheme: (t: ThemeName) => void;
  toggleWorkspace: () => void;
  toggleInspector: () => void;
  setWorkspaceWidth: (w: number) => void;
  setInspectorWidth: (w: number) => void;
  openSettings: (tab?: SettingsTabId) => void;
  closeSettings: () => void;
  showThreadTab: () => void;
  toggleUserMenu: () => void;
  setDir: (path: string, nodes: FsNode[]) => void;
  toggleDir: (path: string) => void;
  toggleProject: (path: string) => void;
};

export const useUiStore = create<UiState>((set) => ({
  theme: 'vellum',
  workspaceCollapsed: false,
  inspectorCollapsed: false,
  workspaceWidth: 260,
  inspectorWidth: 280,
  userMenuOpen: false,
  settingsTabOpen: false,
  settingsTab: 'provider',
  settingsDetailProviderId: null,
  settingsAddProviderOpen: false,
  activeCenterTab: 'thread',
  expandedDirs: new Set(),
  expandedProjects: new Set<string>(),
  dirCache: {},
  projectsGroupBy: 'project',
  projectsSortBy: 'updated',
  setProjectsGroupBy: (g) => set({ projectsGroupBy: g }),
  setProjectsSortBy: (s) => set({ projectsSortBy: s }),
  collapseAllProjects: () => set({ expandedProjects: new Set<string>() }),
  setTheme: (t) => set({ theme: t }),
  toggleWorkspace: () => set((s) => ({ workspaceCollapsed: !s.workspaceCollapsed })),
  toggleInspector: () => set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed })),
  setWorkspaceWidth: (w) => set({ workspaceWidth: Math.max(0, w) }),
  setInspectorWidth: (w) => set({ inspectorWidth: Math.max(0, w) }),
  openSettings: (tab = 'provider') => set({
    settingsTabOpen: true,
    settingsTab: tab,
    activeCenterTab: 'settings',
    userMenuOpen: false,
  }),
  openSettingsDetail: (providerId) => set({ settingsDetailProviderId: providerId, settingsAddProviderOpen: false }),
  closeSettingsDetail: () => set({ settingsDetailProviderId: null }),
  openSettingsAddProvider: () => set({ settingsAddProviderOpen: true, settingsDetailProviderId: null }),
  closeSettingsAddProvider: () => set({ settingsAddProviderOpen: false }),
  closeSettings: () => set({ settingsTabOpen: false, activeCenterTab: 'thread', settingsDetailProviderId: null, settingsAddProviderOpen: false }),
  showThreadTab: () => set({ activeCenterTab: 'thread' }),
  toggleUserMenu: () => set((s) => ({ userMenuOpen: !s.userMenuOpen })),
  setDir: (path, nodes) => set((s) => ({ dirCache: { ...s.dirCache, [path]: nodes } })),
  toggleDir: (path) => set((s) => {
    const next = new Set(s.expandedDirs);
    if (next.has(path)) next.delete(path); else next.add(path);
    return { expandedDirs: next };
  }),
  toggleProject: (path) => set((s) => {
    const next = new Set(s.expandedProjects);
    if (next.has(path)) next.delete(path); else next.add(path);
    return { expandedProjects: next };
  }),
}));
