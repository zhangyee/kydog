import { useEffect } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { NavPill } from './NavPill';
import { NavSection } from './NavSection';
import { TreeChildren } from './TreeChildren';

export function ProjectsTree() {
  const projects = useThreadsStore((s) => s.projects);
  const threadsByProject = useThreadsStore((s) => s.threadsByProject);
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const select = useThreadsStore((s) => s.selectThread);
  const remove = useThreadsStore((s) => s.removeThread);
  const expanded = useUiStore((s) => s.expandedProjects);
  const toggleProject = useUiStore((s) => s.toggleProject);

  // 自动展开当前 thread 所在 project
  useEffect(() => {
    if (!currentThreadId) return;
    const t = Object.values(threadsByProject).flat().find(x => x.id === currentThreadId);
    if (t && !expanded.has(t.projectPath)) toggleProject(t.projectPath);
  }, [currentThreadId, threadsByProject, expanded, toggleProject]);

  // 启动 / 新增 project 时默认展开（让 thread 列表立即可见；用户可手动折叠）
  // 注意：依赖只放 projects，避免用户手动折叠后被 expanded 变化重新触发展开
  useEffect(() => {
    const cur = useUiStore.getState().expandedProjects;
    for (const p of projects) {
      if (!cur.has(p.path)) toggleProject(p.path);
    }
  }, [projects, toggleProject]);

  const onDelete = async (threadId: string) => {
    await window.kydog.invoke('thread.delete', { threadId });
    remove(threadId);
  };

  if (projects.length === 0) {
    return (
      <div className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--color-ink-soft)' }}>
        暂无 Project · 点击下方 ＋ 打开 Project
      </div>
    );
  }

  return (
    <div data-testid="projects-tree">
    <NavSection
      title="课题 · Projects"
      right={
        <button
          type="button"
          data-testid="add-project"
          onClick={async () => {
            try {
              const p = await window.kydog.invoke('project.open');
              useThreadsStore.setState((s) => ({ projects: [...s.projects.filter(x => x.path !== p.path), p] }));
            } catch (err) { console.error(err); }
          }}
          style={{ color: 'var(--color-ink-faint)', cursor: 'pointer', fontSize: 11 }}
        >＋</button>
      }
    >
      {projects.map((p) => {
        const open = expanded.has(p.path);
        const name = p.path.split('/').pop() ?? p.path;
        return (
          <div key={p.path} data-testid={`project-${p.path}`}>
            <div style={{ padding: '2px 6px' }}>
              <NavPill
                icon={open ? 'chevron-down' : 'chevron-right'}
                label={name}
                muted
                onClick={() => toggleProject(p.path)}
                testId={`project-toggle-${name}`}
              />
            </div>
            {open && (
              <TreeChildren>
                {(threadsByProject[p.path] ?? []).map((t) => (
                  <div
                    key={t.id}
                    data-testid={`thread-${t.id}`}
                    className="group relative flex items-center"
                  >
                    <NavPill
                      icon="thread"
                      label={t.title}
                      selected={currentThreadId === t.id}
                      onClick={() => select(t.id)}
                    />
                    <button
                      type="button"
                      data-testid={`delete-thread-${t.id}`}
                      onClick={(e) => { e.stopPropagation(); void onDelete(t.id); }}
                      className="opacity-0 group-hover:opacity-100 px-1 text-xs"
                      style={{ color: 'var(--color-accent)' }}
                    >×</button>
                  </div>
                ))}
                {(threadsByProject[p.path] ?? []).length === 0 && (
                  <div className="text-xs italic px-2 py-1" style={{ color: 'var(--color-ink-soft)' }}>暂无对话</div>
                )}
              </TreeChildren>
            )}
          </div>
        );
      })}
    </NavSection>
    </div>
  );
}
