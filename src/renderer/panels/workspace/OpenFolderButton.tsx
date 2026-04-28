import { useThreadsStore } from '../../stores/threadsStore';

export function OpenFolderButton() {
  const onOpen = async () => {
    try {
      const project = await window.kydog.invoke('project.open');
      useThreadsStore.setState((s) => ({ projects: [...s.projects.filter(p => p.path !== project.path), project] }));
    } catch (err) {
      console.error('open project failed', err);
    }
  };
  return (
    <div style={{ padding: '8px 16px 0' }}>
      <button
        type="button"
        data-testid="open-folder"
        onClick={onOpen}
        className="w-full flex items-center gap-2"
        style={{
          padding: '6px 10px',
          background: 'transparent',
          border: '0.5px dashed var(--color-ink-hair)',
          borderRadius: 4, fontSize: 12, color: 'var(--color-ink-soft)',
        }}
      >
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: 14 }}>＋</span>
        <span>打开 Project</span>
      </button>
    </div>
  );
}
