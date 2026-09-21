import { create } from 'zustand';

/**
 * 主进程每扫完一趟项目文件就广播 `project.fileIndexUpdated`；这里只记一个版本号，
 * 开着的 @ 列表依赖它重查（spec §3.5）。结果本身不进 store —— 它属于那一次查询。
 */
type State = { versionByProject: Record<string, number>; bump: (projectPath: string) => void };

export const useFileIndexStore = create<State>((set) => ({
  versionByProject: {},
  bump: (projectPath) => set((s) => ({
    versionByProject: { ...s.versionByProject, [projectPath]: (s.versionByProject[projectPath] ?? 0) + 1 },
  })),
}));
