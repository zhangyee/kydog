import { useEffect, useRef } from 'react';
import { NavIcon } from '../../shared';
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
  const showThreadTab = useUiStore((s) => s.showThreadTab);
  const autoExpandedThreadRef = useRef<string | null>(null);

  // 自动展开当前 thread 所在 project
  useEffect(() => {
    if (!currentThreadId) {
      autoExpandedThreadRef.current = null;
      return;
    }
    if (autoExpandedThreadRef.current === currentThreadId) return;
    autoExpandedThreadRef.current = currentThreadId;
    const t = Object.values(threadsByProject).flat().find(x => x.id === currentThreadId);
    if (!t) return;
    const cur = useUiStore.getState().expandedProjects;
    if (!cur.has(t.projectPath)) toggleProject(t.projectPath);
  }, [currentThreadId, threadsByProject, toggleProject]);

  // 启动 / 新增 project 时默认展开一次（让 thread 列表立即可见；之后用户拥有折叠状态）
  // 用 ref 记录已经处理过的 project path，避免 projects 引用变化触发的 effect 重新展开用户手动折叠的项
  const seenRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const p of projects) {
      if (seenRef.current.has(p.path)) continue;
      seenRef.current.add(p.path);
      const cur = useUiStore.getState().expandedProjects;
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
      title="课题 Projects"
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
            <NavPill
              icon={<NavIcon name={open ? 'folder-open' : 'folder'} size={15} style={{ opacity: open ? 1 : 0.88 }} />}
              label={name}
              muted
              onClick={() => toggleProject(p.path)}
              testId={`project-toggle-${name}`}
            />
            {open && (
              <TreeChildren>
                {(threadsByProject[p.path] ?? []).map((t) => (
                  <div
                    key={t.id}
                    data-testid={`thread-${t.id}`}
                    className="group relative flex items-center"
                  >
                    <NavPill
                      reserveIconSpace
                      label={t.title}
                      selected={currentThreadId === t.id}
                      onClick={() => {
                        showThreadTab();
                        select(t.id);
                      }}
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
                  <div
                    className="text-xs italic px-2.5 py-1"
                    style={{ paddingLeft: 34, color: 'var(--color-ink-soft)' }}
                  >
                    暂无对话
                  </div>
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
