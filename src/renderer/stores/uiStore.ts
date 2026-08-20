import { create } from 'zustand';
import type { FsNode, ReadingFontSize, ThemeName } from '../../shared/types';
import { fileTitle, isHtmlPath, isPdfPath } from '../panels/main-pane/markdown/fileTabHelpers';

export type FileTab = {
  id: string;                  // = 文件绝对路径（天然唯一键）
  path: string;
  kind: 'md' | 'pdf' | 'html';
  title: string;
  status: 'loading' | 'ready' | 'error';
  diskContent: string | null;  // 上次落盘内容，dirty 比对基准（仅 md）
  dirty: boolean;              // 仅 md；pdf / html 恒 false
  errorMessage?: string;
  reloadNonce: number;         // 外部改动计数；仅 html 消费，用来触发重读
};

export type SettingsTabId = 'provider' | 'donate' | 'about' | 'skills' | 'research';
type CenterTabKind = 'thread' | 'settings' | 'file';

type UiState = {
  theme: ThemeName;
  readingFontSize: ReadingFontSize;
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
  openFileTabs: FileTab[];
  activeFileTabId: string | null;
  openFile: (path: string) => void;
  focusFileTab: (id: string) => void;
  closeFileTab: (id: string) => void;
  setFileTabStatus: (id: string, patch: { status: FileTab['status']; diskContent?: string | null; errorMessage?: string }) => void;
  setFileTabDirty: (id: string, dirty: boolean) => void;
  setFileTabDiskContent: (id: string, content: string) => void;
  markFileChanged: (path: string) => void;
  expandedDirs: Set<string>;
  expandedProjects: Set<string>;
  dirCache: Record<string, FsNode[]>;
  projectsGroupBy: 'project' | 'time';
  projectsSortBy: 'created' | 'updated';
  setProjectsGroupBy: (g: 'project' | 'time') => void;
  setProjectsSortBy: (s: 'created' | 'updated') => void;
  collapseAllProjects: () => void;
  setTheme: (t: ThemeName) => void;
  setReadingFontSize: (s: ReadingFontSize) => void;
  toggleWorkspace: () => void;
  toggleInspector: () => void;
  setWorkspaceWidth: (w: number) => void;
  setInspectorWidth: (w: number) => void;
  openSettings: (tab?: SettingsTabId) => void;
  closeSettings: () => void;
  showThreadTab: () => void;
  toggleUserMenu: () => void;
  setDir: (path: string, nodes: FsNode[]) => void;
  invalidateDir: (path: string) => void;
  toggleDir: (path: string) => void;
  toggleProject: (path: string) => void;
};

export const useUiStore = create<UiState>((set) => ({
  theme: 'vellum',
  readingFontSize: 'medium',
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
  openFileTabs: [],
  activeFileTabId: null,
  openFile: (path) => set((s) => {
    if (s.openFileTabs.some((t) => t.id === path)) {
      return { activeFileTabId: path, activeCenterTab: 'file' };
    }
    const kind: FileTab['kind'] = isPdfPath(path) ? 'pdf' : isHtmlPath(path) ? 'html' : 'md';
    const tab: FileTab = {
      id: path, path, kind,
      title: fileTitle(path),
      status: 'loading', diskContent: null, dirty: false, reloadNonce: 0,
    };
    return {
      openFileTabs: [...s.openFileTabs, tab],
      activeFileTabId: path,
      activeCenterTab: 'file',
    };
  }),
  focusFileTab: (id) => set({ activeFileTabId: id, activeCenterTab: 'file' }),
  closeFileTab: (id) => set((s) => {
    const remaining = s.openFileTabs.filter((t) => t.id !== id);
    const wasActive = s.activeFileTabId === id;
    const nextActive = wasActive
      ? (remaining.length ? remaining[remaining.length - 1].id : null)
      : s.activeFileTabId;
    return {
      openFileTabs: remaining,
      activeFileTabId: nextActive,
      activeCenterTab: wasActive && remaining.length === 0 && s.activeCenterTab === 'file' ? 'thread' : s.activeCenterTab,
    };
  }),
  setFileTabStatus: (id, patch) => set((s) => ({
    openFileTabs: s.openFileTabs.map((t) => t.id === id ? {
      ...t,
      status: patch.status,
      diskContent: patch.diskContent !== undefined ? patch.diskContent : t.diskContent,
      errorMessage: patch.errorMessage,
    } : t),
  })),
  setFileTabDirty: (id, dirty) => set((s) => ({
    openFileTabs: s.openFileTabs.map((t) => t.id === id ? { ...t, dirty } : t),
  })),
  setFileTabDiskContent: (id, content) => set((s) => ({
    openFileTabs: s.openFileTabs.map((t) => t.id === id ? { ...t, diskContent: content, dirty: false } : t),
  })),
  // 只给 html tab 加计数。md tab 有未保存修改，外部改动怎么和本地脏状态合并是
  // 另一个问题，现在不碰；pdf tab 不需要。
  markFileChanged: (path) => set((s) => {
    if (!s.openFileTabs.some((t) => t.path === path && t.kind === 'html')) return s;
    return {
      openFileTabs: s.openFileTabs.map((t) =>
        t.path === path && t.kind === 'html' ? { ...t, reloadNonce: t.reloadNonce + 1 } : t),
    };
  }),
  expandedDirs: new Set(),
  expandedProjects: new Set<string>(),
  dirCache: {},
  projectsGroupBy: 'project',
  projectsSortBy: 'updated',
  setProjectsGroupBy: (g) => set({ projectsGroupBy: g }),
  setProjectsSortBy: (s) => set({ projectsSortBy: s }),
  collapseAllProjects: () => set({ expandedProjects: new Set<string>() }),
  setTheme: (t) => set({ theme: t }),
  setReadingFontSize: (s) => set({ readingFontSize: s }),
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
  invalidateDir: (path) => set((s) => {
    if (!(path in s.dirCache)) return s;
    const next = { ...s.dirCache };
    delete next[path];
    return { dirCache: next };
  }),
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
