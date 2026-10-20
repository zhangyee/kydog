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

/** The rendered DFS order, including directory rows and only expanded descendants. */
export function visibleFileRows(projectPath: string, cache: Readonly<Record<string, FsNode[]>>, expanded: ReadonlySet<string>, sortBy: FileSortBy): Array<{ node: FsNode; parentPath: string; depth: number }> {
  const rows: Array<{ node: FsNode; parentPath: string; depth: number }> = [];
  const visit = (parentPath: string, depth: number) => {
    for (const node of sortFileNodes(cache[parentPath] ?? [], sortBy)) {
      rows.push({ node, parentPath, depth });
      if (node.kind === 'dir' && expanded.has(node.path)) visit(node.path, depth + 1);
    }
  };
  visit(projectPath, 0);
  return rows;
}
