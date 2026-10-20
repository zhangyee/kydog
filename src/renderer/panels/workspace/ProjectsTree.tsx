import { useEffect, useRef } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { NavSection } from './NavSection';
import { TreeChildren } from './TreeChildren';
import { ProjectsHeaderActions } from './ProjectsHeaderActions';
import { ProjectRow } from './ProjectRow';
import { ThreadRow } from './ThreadRow';
import { applyProjectsView, projectThreadsPreview } from './projectsView';
import { useSidebarSelection, visibleThreadOrder, effectiveSelection } from './sidebarSelection';

export function ProjectsTree() {
  const projects = useThreadsStore((s) => s.projects);
  const threadsByProject = useThreadsStore((s) => s.threadsByProject);
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const navigationRevision = useThreadsStore((s) => s.threadNavigationRevision);
  const showAll = useUiStore((s) => s.showAllThreadProjects);
  const showAllProjectThreads = useUiStore((s) => s.showAllProjectThreads);
  const collapsed = useUiStore((s) => s.collapsedProjects);
  const toggleProject = useUiStore((s) => s.toggleProject);
  const expandProject = useUiStore((s) => s.expandProject);
  const groupBy = useUiStore((s) => s.projectsGroupBy);
  const sortBy = useUiStore((s) => s.projectsSortBy);

  const fullView = applyProjectsView({ projects, threadsByProject, groupBy, sortBy });
  const view = projectThreadsPreview(fullView, showAll);
  const selectedIds = useSidebarSelection((s) => s.selectedIds);
  // 可见顺序与有效选中每次渲染现算，不另存（spec §2.2：收起项目下的行不算选中）。
  const order = visibleThreadOrder(view, collapsed);
  const selection = effectiveSelection(selectedIds, order);

  // 每个明确导航只消费一次。手动重开项目不是导航；数据未齐时保留未消费身份，
  // 等目标与所属项目到达后再展开，不能因提前记下 ID 而丢掉恢复导航。
  const consumedNavigationRef = useRef<number | null>(null);
  useEffect(() => {
    if (!currentThreadId || consumedNavigationRef.current === navigationRevision) return;
    const t = Object.values(threadsByProject).flat().find(x => x.id === currentThreadId);
    if (!t || !projects.some(p => p.path === t.projectPath)) return;
    const grouped = applyProjectsView({ projects, threadsByProject, groupBy: 'project', sortBy });
    if (grouped.kind !== 'grouped') return;
    const group = grouped.groups.find(g => g.project.path === t.projectPath);
    if (!group) return;
    consumedNavigationRef.current = navigationRevision;
    expandProject(t.projectPath);
    if (group.threads.findIndex(thread => thread.id === currentThreadId) >= 5) {
      showAllProjectThreads(t.projectPath);
    }
  }, [currentThreadId, navigationRevision, threadsByProject, projects, sortBy, expandProject, showAllProjectThreads]);

  if (projects.length === 0) {
    return (
      <div className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--color-ink-soft)' }}>
        暂无 Project
      </div>
    );
  }

  return (
    <div data-testid="projects-tree">
      <NavSection title="课题 Projects" right={<ProjectsHeaderActions />}>
        {view.kind === 'grouped' ? (
          view.groups.map(({ project, threads }) => {
            const open = !collapsed.has(project.path);
            return (
              <div key={project.path} data-testid={`project-${project.path}`}>
                <ProjectRow
                  project={project}
                  expanded={open}
                  onToggleExpand={() => toggleProject(project.path)}
                />
                {open && (
                  <TreeChildren>
                    {threads.map((t) => <ThreadRow key={t.id} thread={t} selection={selection} order={order} />)}
                    {!showAll.has(project.path) && fullView.kind === 'grouped'
                      && (fullView.groups.find(g => g.project.path === project.path)?.threads.length ?? 0) > 5 && (
                      <button
                        type="button"
                        data-testid={`project-show-more-${project.path}`}
                        className="text-xs px-2.5 py-1 hover:bg-[color:var(--color-hover-bg)] rounded"
                        style={{ marginLeft: 34, color: 'var(--color-ink-soft)' }}
                        onClick={() => showAllProjectThreads(project.path)}
                      >展开显示</button>
                    )}
                    {threads.length === 0 && (
                      <div className="text-xs italic px-2.5 py-1" style={{ paddingLeft: 34, color: 'var(--color-ink-soft)' }}>
                        暂无对话
                      </div>
                    )}
                  </TreeChildren>
                )}
              </div>
            );
          })
        ) : (
          <div style={{ padding: '2px 6px' }}>
            {view.threads.map((t) => <ThreadRow key={t.id} thread={t} selection={selection} order={order} />)}
            {view.threads.length === 0 && (
              <div className="text-xs italic px-2.5 py-1" style={{ color: 'var(--color-ink-soft)' }}>
                暂无对话
              </div>
            )}
          </div>
        )}
      </NavSection>
    </div>
  );
}
