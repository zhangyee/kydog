import { KyLogo } from '../../shared';
import { useThreadsStore } from '../../stores/threadsStore';
import type { Project } from '../../../shared/types';

export function Welcome() {
  const projects = useThreadsStore((s) => s.projects);

  const onOpen = async (): Promise<Project | null> => {
    try {
      const project = await window.kydog.invoke('project.open');
      useThreadsStore.setState((s) => ({
        projects: [...s.projects.filter((p) => p.path !== project.path), project],
      }));
      return project;
    } catch (err) {
      console.error('open project failed', err);
      return null;
    }
  };

  const onNewThread = async () => {
    let projectPath: string | undefined;
    if (projects.length === 0) {
      const picked = await onOpen();
      if (!picked) return;
      projectPath = picked.path;
    } else {
      projectPath = projects[0].path;
    }
    try {
      const thread = await window.kydog.invoke('thread.create', { projectPath });
      useThreadsStore.getState().upsertThread(thread);
      useThreadsStore.getState().selectThread(thread.id);
    } catch (err) {
      console.error('create thread failed', err);
    }
  };

  return (
    <div className="ky-paper-grain h-full flex flex-col items-center justify-center select-none">
      <div className="flex items-baseline" style={{ gap: 18 }}>
        <KyLogo size={68} peerSize />
      </div>
      <div
        className="font-serif italic"
        style={{
          marginTop: 18,
          fontSize: 20,
          color: 'var(--color-ink)',
          letterSpacing: 0.3,
        }}
      >
        Building a better world.
      </div>
      <div
        className="font-mono uppercase"
        style={{
          marginTop: 28,
          fontSize: 10,
          letterSpacing: 3,
          color: 'var(--color-ink-faint)',
        }}
      >
        — 选择一个 Project，或新建一个对话 —
      </div>
      <div className="flex gap-3" style={{ marginTop: 24 }}>
        <button
          type="button"
          data-testid="welcome-open-folder"
          onClick={onOpen}
          className="font-sans"
          style={{
            padding: '8px 18px',
            fontSize: 13,
            color: 'var(--color-ink)',
            background: 'var(--color-paper)',
            border: '0.5px solid var(--color-ink-hair)',
            borderRadius: 4,
            cursor: 'pointer',
            boxShadow: '0 1px 0 rgba(70,55,40,0.05)',
          }}
        >
          ＋ 打开 Project
        </button>
        <button
          type="button"
          data-testid="welcome-new-thread"
          onClick={onNewThread}
          className="font-sans"
          style={{
            padding: '8px 18px',
            fontSize: 13,
            color: 'var(--color-paper)',
            background: 'var(--color-accent)',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          ✣ 新建对话
        </button>
      </div>
    </div>
  );
}
