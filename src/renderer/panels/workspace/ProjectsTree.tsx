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
  const expanded = useUiStore((s) => s.expandedProjects);
  const toggleProject = useUiStore((s) => s.toggleProject);
  const groupBy = useUiStore((s) => s.projectsGroupBy);
  const sortBy = useUiStore((s) => s.projectsSortBy);

  const view = applyProjectsView({ projects, threadsByProject, groupBy, sortBy });

  const autoExpandedThreadRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentThreadId) { autoExpandedThreadRef.current = null; return; }
    if (autoExpandedThreadRef.current === currentThreadId) return;
    autoExpandedThreadRef.current = currentThreadId;
    const t = Object.values(threadsByProject).flat().find(x => x.id === currentThreadId);
    if (!t) return;
    const cur = useUiStore.getState().expandedProjects;
    if (!cur.has(t.projectPath)) toggleProject(t.projectPath);
  }, [currentThreadId, threadsByProject, toggleProject]);

  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const p of projects) {
      if (seenRef.current.has(p.path)) continue;
      seenRef.current.add(p.path);
      const cur = useUiStore.getState().expandedProjects;
      if (!cur.has(p.path)) toggleProject(p.path);
    }
  }, [projects, toggleProject]);

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
            const open = expanded.has(project.path);
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
