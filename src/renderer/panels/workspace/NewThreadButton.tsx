import { useThreadsStore } from '../../stores/threadsStore';

export function NewThreadButton() {
  const projects = useThreadsStore((s) => s.projects);
  const upsert = useThreadsStore((s) => s.upsertThread);
  const select = useThreadsStore((s) => s.selectThread);
  const enabled = projects.length > 0;
  const onClick = async () => {
    if (!enabled) return;
    const projectPath = projects[0].path;   // A2 简化：第一个 project；后续 phase 从树点击决定
    const thread = await window.kydog.invoke('thread.create', { projectPath });
    upsert(thread);
    select(thread.id);
  };
  return (
    <div style={{ padding: '10px 16px 0' }}>
      <button
        type="button"
        data-testid="new-thread"
        disabled={!enabled}
        onClick={onClick}
        className="w-full flex items-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          padding: '7px 10px',
          background: 'var(--color-paper)',
          border: '0.5px solid var(--color-ink-hair)',
          borderRadius: 4, fontSize: 12, color: 'var(--color-ink)',
          boxShadow: '0 1px 0 rgba(70,55,40,0.05)',
        }}
      >
        <span style={{ fontFamily: 'var(--font-serif)', color: 'var(--color-accent)', fontSize: 14, lineHeight: 1 }}>✣</span>
        <span style={{ flex: 1, textAlign: 'left' }}>新建对话</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-ink-faint)' }}>⌘N</span>
      </button>
    </div>
  );
}
