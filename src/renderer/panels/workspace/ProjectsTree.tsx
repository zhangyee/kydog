import { useThreadsStore } from '../../stores/threadsStore';

export function ProjectsTree() {
  const projects = useThreadsStore((s) => s.projects);
  const threadsByProject = useThreadsStore((s) => s.threadsByProject);
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const select = useThreadsStore((s) => s.selectThread);
  const remove = useThreadsStore((s) => s.removeThread);

  const onDelete = async (threadId: string) => {
    await window.kydog.invoke('thread.delete', { threadId });
    remove(threadId);
  };

  if (projects.length === 0) {
    return <div className="px-3 py-2 text-xs font-mono text-[color:var(--color-ink-soft)]">暂无 Project</div>;
  }
  return (
    <div className="px-3 text-sm font-sans" data-testid="projects-tree">
      {projects.map((p) => (
        <div key={p.path} className="mb-2">
          <div className="text-[color:var(--color-ink-soft)] truncate">{p.path.split('/').pop()}</div>
          <div className="ml-3 border-l border-[color:var(--color-paper-edge)] pl-2">
            {(threadsByProject[p.path] ?? []).map((t) => (
              <div
                key={t.id}
                data-testid={`thread-${t.id}`}
                className={`group py-0.5 truncate flex items-center justify-between cursor-pointer ${currentThreadId === t.id ? 'bg-[oklch(0.94_0.008_60)]' : ''}`}
                onClick={() => select(t.id)}
              >
                <span className="truncate">{t.title}</span>
                <button
                  data-testid={`delete-thread-${t.id}`}
                  onClick={(e) => { e.stopPropagation(); void onDelete(t.id); }}
                  className="opacity-0 group-hover:opacity-100 text-[color:var(--color-accent)] text-xs px-1"
                >×</button>
              </div>
            ))}
            {(threadsByProject[p.path] ?? []).length === 0 && (
              <div className="text-xs text-[color:var(--color-ink-soft)] italic">暂无对话</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
