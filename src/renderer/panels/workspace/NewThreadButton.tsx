import { useThreadsStore } from '../../stores/threadsStore';

export function NewThreadButton() {
  const projects = useThreadsStore((s) => s.projects);
  const upsert = useThreadsStore((s) => s.upsertThread);
  const select = useThreadsStore((s) => s.selectThread);
  const enabled = projects.length > 0;
  const onClick = async () => {
    const projectPath = projects[0].path; // A2: single-project default; user picks via tree click in Phase 3
    const thread = await window.kydog.invoke('thread.create', { projectPath });
    upsert(thread);
    select(thread.id);
  };
  return (
    <button
      type="button"
      data-testid="new-thread"
      disabled={!enabled}
      onClick={onClick}
      className="mx-3 mb-2 text-sm font-sans px-2 py-1 border rounded disabled:opacity-50 hover:bg-[color:var(--color-paper-edge)]"
    >
      ✣ 新建对话
    </button>
  );
}
