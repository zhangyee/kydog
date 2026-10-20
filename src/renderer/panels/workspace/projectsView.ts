import type { Project, Thread } from '../../../shared/types';

export type GroupBy = 'project' | 'time';
export type SortBy = 'created' | 'updated';

export type GroupedView = {
  kind: 'grouped';
  groups: Array<{ project: Project; threads: Thread[] }>;
};

export type FlatView = {
  kind: 'flat';
  threads: Thread[];
};

export type ProjectsView = GroupedView | FlatView;

type Args = {
  projects: Project[];
  threadsByProject: Record<string, Thread[]>;
  groupBy: GroupBy;
  sortBy: SortBy;
};

function threadKey(t: Thread, sortBy: SortBy): string {
  return sortBy === 'created' ? t.createdAt : t.lastActiveAt;
}

function sortThreads(threads: Thread[], sortBy: SortBy): Thread[] {
  const arr = threads.slice();
  arr.sort((a, b) => {
    const aPinned = !!a.pinned;
    const bPinned = !!b.pinned;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    return threadKey(b, sortBy).localeCompare(threadKey(a, sortBy));
  });
  return arr;
}

export function applyProjectsView({ projects, threadsByProject, groupBy, sortBy }: Args): ProjectsView {
  if (groupBy === 'time') {
    const all: Thread[] = [];
    for (const p of projects) all.push(...(threadsByProject[p.path] ?? []));
    return { kind: 'flat', threads: sortThreads(all, sortBy) };
  }
  const sortedProjects = projects.slice().sort((a, b) => {
    const aPinned = !!a.pinned;
    const bPinned = !!b.pinned;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    return 0;
  });
  return {
    kind: 'grouped',
    groups: sortedProjects.map((p) => ({
      project: p,
      threads: sortThreads(threadsByProject[p.path] ?? [], sortBy),
    })),
  };
}


/** 完整排序后再取预览；完整 view 留给导航定位与总数。平铺不受项目预览影响。 */
export function projectThreadsPreview(view: ProjectsView, showAllProjects: ReadonlySet<string>): ProjectsView {
  if (view.kind === 'flat') return view;
  return {
    kind: 'grouped',
    groups: view.groups.map(group => ({
      ...group,
      threads: showAllProjects.has(group.project.path) ? group.threads : group.threads.slice(0, 5),
    })),
  };
}
