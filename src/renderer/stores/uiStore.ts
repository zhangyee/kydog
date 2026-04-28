import { create } from 'zustand';
import type { FsNode, ThemeName } from '../../shared/types';

type UiState = {
  theme: ThemeName;
  workspaceCollapsed: boolean;
  inspectorCollapsed: boolean;
  settingsModalOpen: boolean;
  settingsModalCloseable: boolean;
  userMenuOpen: boolean;
  expandedDirs: Set<string>;
  expandedProjects: Set<string>;
  dirCache: Record<string, FsNode[]>;
  setTheme: (t: ThemeName) => void;
  toggleWorkspace: () => void;
  toggleInspector: () => void;
  openSettings: (closeable?: boolean) => void;
  closeSettings: () => void;
  toggleUserMenu: () => void;
  setDir: (path: string, nodes: FsNode[]) => void;
  toggleDir: (path: string) => void;
  toggleProject: (path: string) => void;
};

export const useUiStore = create<UiState>((set) => ({
  theme: 'vellum',
  workspaceCollapsed: false,
  inspectorCollapsed: false,
  settingsModalOpen: false,
  settingsModalCloseable: true,
  userMenuOpen: false,
  expandedDirs: new Set(),
  expandedProjects: new Set<string>(),
  dirCache: {},
  setTheme: (t) => set({ theme: t }),
  toggleWorkspace: () => set((s) => ({ workspaceCollapsed: !s.workspaceCollapsed })),
  toggleInspector: () => set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed })),
  openSettings: (closeable = true) => set({ settingsModalOpen: true, settingsModalCloseable: closeable }),
  closeSettings: () => set({ settingsModalOpen: false }),
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
