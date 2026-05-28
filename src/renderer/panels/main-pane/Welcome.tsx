import { KyLogo, KyMascot, NavIcon } from '../../shared';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { useUnreadStore } from '../workspace/unreadStore';
import type { Project } from '../../../shared/types';

export function Welcome() {
  const projects = useThreadsStore((s) => s.projects);
  const showThreadTab = useUiStore((s) => s.showThreadTab);

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
      showThreadTab();
      useThreadsStore.getState().selectThread(thread.id);
      useUnreadStore.getState().markRead(thread.id);
    } catch (err) {
      console.error('create thread failed', err);
    }
  };

  return (
    <div className="ky-paper-grain h-full flex flex-col items-center justify-center select-none">
      <div style={{ color: 'var(--color-ink)', marginBottom: 14 }}>
        <KyMascot size={72} />
      </div>
      <div className="flex items-baseline" style={{ gap: 18 }}>
        <KyLogo size={68} peerSize />
      </div>
      <div
        data-testid="welcome-slogan"
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
          className="group font-sans flex items-center gap-2 bg-[color:var(--color-paper)] transition-colors hover:bg-[color:var(--color-hover-bg)]"
          style={{
            padding: '8px 14px',
            fontSize: 13,
            color: 'var(--color-ink)',
            border: '0.5px solid var(--color-ink-hair)',
            borderRadius: 4,
            cursor: 'pointer',
            boxShadow: '0 1px 0 var(--color-card-shadow)',
          }}
        >
          <span
            className="inline-flex items-center justify-center font-sans"
            style={{ width: 16, height: 16, fontSize: 18, lineHeight: 1, color: 'var(--color-accent)' }}
          >
            ＋
          </span>
          <span>打开项目文件夹</span>
          <span
            className="font-mono opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ fontSize: 12, color: 'var(--color-ink-faint)', marginLeft: 4 }}
          >
            ⌘O
          </span>
        </button>
        <button
          type="button"
          data-testid="welcome-new-thread"
          onClick={onNewThread}
          className="group font-sans flex items-center gap-2 bg-[color:var(--color-paper)] transition-colors hover:bg-[color:var(--color-hover-bg)]"
          style={{
            padding: '8px 14px',
            fontSize: 13,
            color: 'var(--color-ink)',
            border: '0.5px solid var(--color-ink-hair)',
            borderRadius: 4,
            cursor: 'pointer',
            boxShadow: '0 1px 0 var(--color-card-shadow)',
          }}
        >
          <span
            className="inline-flex items-center justify-center"
            style={{ width: 16, height: 16, color: 'var(--color-accent)' }}
          >
            <NavIcon name="square-pen" size={15} />
          </span>
          <span>新对话</span>
          <span
            className="font-mono opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ fontSize: 12, color: 'var(--color-ink-faint)', marginLeft: 4 }}
          >
            ⌘N
          </span>
        </button>
      </div>
    </div>
  );
}
