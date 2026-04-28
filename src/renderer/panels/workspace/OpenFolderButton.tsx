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
    <button
      type="button"
      data-testid="open-folder"
      className="m-3 text-sm font-sans px-2 py-1 border rounded hover:bg-[color:var(--color-paper-edge)]"
      onClick={onOpen}
    >
      ＋ 打开 Project
    </button>
  );
}
