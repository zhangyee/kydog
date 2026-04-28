import { useEffect } from 'react';
import { ThemeApplier } from './ThemeApplier';
import { TitleBar } from './TitleBar';
import { ThreeColumnLayout } from './ThreeColumnLayout';
import { ErrorBoundary } from './ErrorBoundary';
import { WorkspacePanel } from '../panels/workspace/WorkspacePanel';
import { MainPane } from '../panels/main-pane/MainPane';
import { InspectorPanel } from '../panels/inspector/InspectorPanel';
import { SettingsModal } from '../settings/SettingsModal';
import { useThreadsStore } from '../stores/threadsStore';

export function AppShell() {
  const currentTitle = useThreadsStore((s) => {
    if (!s.currentThreadId) return undefined;
    const t = Object.values(s.threadsByProject).flat().find(x => x.id === s.currentThreadId);
    if (!t) return undefined;
    return `${t.title} · ${t.projectPath.split(/[\\/]/).pop() ?? ''}`;
  });

  // ⌘N / Ctrl+N → new thread (uses first project; mirrors NewThreadButton)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n' && !e.shiftKey) {
        e.preventDefault();
        const { projects } = useThreadsStore.getState();
        if (!projects.length) return;
        void window.kydog.invoke('thread.create', { projectPath: projects[0].path }).then((thread) => {
          useThreadsStore.getState().upsertThread(thread);
          useThreadsStore.getState().selectThread(thread.id);
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-full flex flex-col">
      <ThemeApplier />
      <TitleBar title={currentTitle} />
      <div className="flex-1 min-h-0">
        <ThreeColumnLayout
          left={<ErrorBoundary fallbackLabel="工作区出错"><WorkspacePanel /></ErrorBoundary>}
          center={<ErrorBoundary fallbackLabel="主内容区出错"><MainPane /></ErrorBoundary>}
          right={<ErrorBoundary fallbackLabel="检视区出错"><InspectorPanel /></ErrorBoundary>}
        />
      </div>
      <SettingsModal />
    </div>
  );
}
