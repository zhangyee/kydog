import { create } from 'zustand';
import type { FsNode, ReadingFontSize, SkillSyncHealth, ThemeName } from '../../shared/types';
import { fileTitle, isHtmlPath, isPdfPath } from '../panels/main-pane/markdown/fileTabHelpers';
import { clampBrowserWidth } from '../panels/browser/stage';
import { availableForCenterAndRight } from '../app/rightPane';

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
  /**
   * 浏览器侧栏开着吗。**与 `inspectorCollapsed` 是两件事**：两者共用右栏那块地，
   * 但各记各的状态与宽度 —— 关掉浏览器时 Inspector 要回到用户上次留下的样子
   * （收着的仍然收着），而不是被浏览器的开关顺手掰开。
   */
  browserOpen: boolean;
  /** `null` = 用户从没拖过，排版按 4:6 现算，见 `rightPane.ts` 的 `browserWidthFor`。 */
  browserWidth: number | null;
  /**
   * 全屏浏览器（中栏藏起来，右栏吃满可用宽度）。**不落盘** —— 见 `bootstrap.ts`
   * 的持久化订阅：加进去就等于「退出时停在全屏，下次开应用看不见对话」，
   * 用户会以为应用坏了。
   */
  browserFullscreen: boolean;
  toggleBrowserFullscreen: () => void;
  /**
   * 窗口宽。**只由 `bootstrap.ts` 的 resize 监听维护**，组件里不量：组件那一层
   * 跑在 `environment: 'node'` 的用例里，没有 `window` 也没有 `ResizeObserver`。
   */
  windowWidth: number;
  setWindowWidth: (w: number) => void;
  userMenuOpen: boolean;
  /** 内置 skill 同步的健康度。null = 还没问过主进程，与「问过、答的是 skipped」不是一回事。
   *  UI 一律读这个显式状态，不许从「skill 列表是空的」反推 —— 空列表在 skipped 与 failed
   *  下含义完全不同（前者是还没播种，后者是播种失败）。 */
  skillSyncHealth: SkillSyncHealth | null;
  setSkillSyncHealth: (h: SkillSyncHealth) => void;
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
  /** 记「收起」而不是「展开」：project 默认展开，只有用户显式收起的才进这个集合。
   *  倒过来记的话，「刚加进来还没人碰过」与「用户展开过」在集合里长得一模一样，
   *  于是要么新 project 一律是收起的，要么得靠一个 seen 表在渲染期替它补记录 ——
   *  两条都是拿启发式补上游丢掉的信号。落盘的是 settings.ui.collapsedProjects。 */
  collapsedProjects: Set<string>;
  dirCache: Record<string, FsNode[]>;
  projectsGroupBy: 'project' | 'time';
  projectsSortBy: 'created' | 'updated';
  setProjectsGroupBy: (g: 'project' | 'time') => void;
  setProjectsSortBy: (s: 'created' | 'updated') => void;
  collapseAllProjects: (paths: string[]) => void;
  expandProject: (path: string) => void;
  setTheme: (t: ThemeName) => void;
  setReadingFontSize: (s: ReadingFontSize) => void;
  toggleWorkspace: () => void;
  toggleInspector: () => void;
  toggleBrowser: () => void;
  closeBrowser: () => void;
  setWorkspaceWidth: (w: number) => void;
  setInspectorWidth: (w: number) => void;
  setBrowserWidth: (w: number) => void;
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
  browserOpen: false,
  browserWidth: null,
  browserFullscreen: false,
  toggleBrowserFullscreen: () => set((s) => ({ browserFullscreen: !s.browserFullscreen })),
  windowWidth: 1280,
  setWindowWidth: (w) => set({ windowWidth: w }),
  userMenuOpen: false,
  skillSyncHealth: null,
  setSkillSyncHealth: (h) => set({ skillSyncHealth: h }),
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
  // html 与 md tab 都加计数：两者都要跟着磁盘走。计数只是「该去看一眼了」的信号，
  // 看完之后怎么处置由各自的 tab 决定 —— md 那边还要拿新内容跟 diskContent 逐字节
  // 比一次（滤掉自己 ⌘S 写出去的回声），并且在本地有未保存修改时改成提示而不是覆盖。
  // pdf tab 不消费这个计数。
  markFileChanged: (path) => set((s) => {
    const watches = (t: FileTab) => t.path === path && (t.kind === 'html' || t.kind === 'md');
    if (!s.openFileTabs.some(watches)) return s;
    return {
      openFileTabs: s.openFileTabs.map((t) =>
        watches(t) ? { ...t, reloadNonce: t.reloadNonce + 1 } : t),
    };
  }),
  expandedDirs: new Set(),
  collapsedProjects: new Set<string>(),
  dirCache: {},
  projectsGroupBy: 'project',
  projectsSortBy: 'updated',
  setProjectsGroupBy: (g) => set({ projectsGroupBy: g }),
  setProjectsSortBy: (s) => set({ projectsSortBy: s }),
  collapseAllProjects: (paths) => set({ collapsedProjects: new Set(paths) }),
  setTheme: (t) => set({ theme: t }),
  setReadingFontSize: (s) => set({ readingFontSize: s }),
  toggleWorkspace: () => set((s) => ({ workspaceCollapsed: !s.workspaceCollapsed })),
  toggleInspector: () => set((s) => ({ inspectorCollapsed: !s.inspectorCollapsed })),
  // 关的那一支要跟 closeBrowser 对齐：顺手清掉全屏。标题栏地球按钮走的正是这条路
  // （不是 closeBrowser）——漏了这句的话，开→全屏→用地球关→用地球再开，
  // browserFullscreen 残留 true，rightPaneLayout 会把中栏判成 centerHidden，
  // 对话栏 0px，而用户按的明明是「打开侧栏」。
  toggleBrowser: () => set((s) => {
    const browserOpen = !s.browserOpen;
    return browserOpen ? { browserOpen } : { browserOpen, browserFullscreen: false };
  }),
  // 关掉浏览器时顺手清掉全屏 —— 留着的话下次打开会直接是全屏，而用户按的是「打开侧栏」。
  closeBrowser: () => set({ browserOpen: false, browserFullscreen: false }),
  setWorkspaceWidth: (w) => set({ workspaceWidth: Math.max(0, w) }),
  setInspectorWidth: (w) => set({ inspectorWidth: Math.max(0, w) }),
  // **拖拽时当场钳**，与另外两栏那句 `Math.max(0, w)` 不同：这个宽度会立刻经
  // `browser.syncView` 变成原生 WebContentsView 的 bounds，非法值当场就生效了；
  // 而落盘那一侧的 `sanitizeBrowserWidth` 是 fire-and-forget 的，赶不上。
  //
  // 上界同样当场钳，不等 `rightPaneLayout` 排版时再压：`MIN_MAIN_WIDTH = 360` 意味着
  // 对话栏要留够地方，浏览器最宽只能到 `availableForCenterAndRight(...) - MIN_MAIN_WIDTH`。
  // 不钳的话，用户拖到超出这个上界、松手后排版把它压回去 —— 存的数和排出来的宽度对不上，
  // 手感是「拖完自己弹回去了」。
  setBrowserWidth: (w) => set((s) => ({
    browserWidth: clampBrowserWidth(w, availableForCenterAndRight(s.windowWidth, s.workspaceCollapsed, s.workspaceWidth)),
  })),
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
    const next = new Set(s.collapsedProjects);
    if (next.has(path)) next.delete(path); else next.add(path);
    return { collapsedProjects: next };
  }),
  expandProject: (path) => set((s) => {
    if (!s.collapsedProjects.has(path)) return {};
    const next = new Set(s.collapsedProjects);
    next.delete(path);
    return { collapsedProjects: next };
  }),
}));
