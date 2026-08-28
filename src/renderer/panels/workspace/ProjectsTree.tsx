import { useEffect, useRef } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { NavSection } from './NavSection';
import { TreeChildren } from './TreeChildren';
import { ProjectsHeaderActions } from './ProjectsHeaderActions';
import { ProjectRow } from './ProjectRow';
import { ThreadRow } from './ThreadRow';
import { applyProjectsView } from './projectsView';

export function ProjectsTree() {
  const projects = useThreadsStore((s) => s.projects);
  const threadsByProject = useThreadsStore((s) => s.threadsByProject);
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const collapsed = useUiStore((s) => s.collapsedProjects);
  const toggleProject = useUiStore((s) => s.toggleProject);
  const expandProject = useUiStore((s) => s.expandProject);
  const groupBy = useUiStore((s) => s.projectsGroupBy);
  const sortBy = useUiStore((s) => s.projectsSortBy);

  const view = applyProjectsView({ projects, threadsByProject, groupBy, sortBy });

  // 选中某个 thread 时把它所在的 project 展开一次。ref 记住「已经为这个 thread
  // 展开过了」，否则用户随后手动收起会被这个 effect 立刻顶回去（见 e2e/17）。
  const autoExpandedThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentThreadId) { autoExpandedThreadRef.current = null; return; }
    if (autoExpandedThreadRef.current === currentThreadId) return;
    autoExpandedThreadRef.current = currentThreadId;
    const t = Object.values(threadsByProject).flat().find(x => x.id === currentThreadId);
    if (!t) return;
    expandProject(t.projectPath);
  }, [currentThreadId, threadsByProject, expandProject]);

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
                    {threads.map((t) => <ThreadRow key={t.id} thread={t} />)}
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
            {view.threads.map((t) => <ThreadRow key={t.id} thread={t} />)}
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
