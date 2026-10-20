import type { FsNode } from '../../../shared/types';

export type FileSortBy = 'name' | 'modified';

/** 排序只是显示派生结果，不改动 readDir 的共享缓存。 */
export function sortFileNodes(nodes: readonly FsNode[], sortBy: FileSortBy): FsNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    if (a.kind === 'file' && sortBy === 'modified') {
      if (a.mtimeMs === null && b.mtimeMs !== null) return 1;
      if (b.mtimeMs === null && a.mtimeMs !== null) return -1;
      if (a.mtimeMs !== null && b.mtimeMs !== null && a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    }
    return a.name.localeCompare(b.name);
  });
}
