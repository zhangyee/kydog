import { useEffect, useState } from 'react';
import { ThemeApplier } from './ThemeApplier';
import { ReadingFontSizeApplier } from './ReadingFontSizeApplier';
import { TitleBar } from './TitleBar';
import { UpdateBanner } from './UpdateBanner';
import { ThreeColumnLayout } from './ThreeColumnLayout';
import { ErrorBoundary } from './ErrorBoundary';
import { SkillSyncModal } from './SkillSyncModal';
import { ConfirmHost } from './ConfirmHost';
import { WorkspacePanel } from '../panels/workspace/WorkspacePanel';
import { MainPane } from '../panels/main-pane/MainPane';
import { InspectorPanel } from '../panels/inspector/InspectorPanel';
import { useThreadsStore } from '../stores/threadsStore';
import { useUiStore } from '../stores/uiStore';
import { useUnreadStore } from '../panels/workspace/unreadStore';
import { SETTINGS_PAGE_LABELS } from '../settings/settingsPages';
import type { SkillSyncStatus } from '../../shared/types';

export function AppShell() {
  const [skillSync, setSkillSync] = useState<SkillSyncStatus | null>(null);

  useEffect(() => {
    let mounted = true;
    void window.kydog.invoke('skill.getPendingSync').then((s) => {
      if (mounted) setSkillSync(s);
    }).catch((err) => {
      console.error('skill.getPendingSync failed', err);
    });
    return () => { mounted = false; };
  }, []);

  const activeCenterTab = useUiStore((s) => s.activeCenterTab);
  const settingsTabOpen = useUiStore((s) => s.settingsTabOpen);
  const settingsTab = useUiStore((s) => s.settingsTab);
  const currentTitle = useThreadsStore((s) => {
    if (activeCenterTab === 'settings' && settingsTabOpen) return SETTINGS_PAGE_LABELS[settingsTab];
    if (!s.currentThreadId) return undefined;
    const t = Object.values(s.threadsByProject).flat().find(x => x.id === s.currentThreadId);
    if (!t) return undefined;
    return `${t.title} · ${t.projectPath.split(/[\\/]/).pop() ?? ''}`;
  });

  // ⌘N → new thread, ⌘O → open project folder. 聚焦输入框时不拦截。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        const { projects } = useThreadsStore.getState();
        if (!projects.length) return;
        void window.kydog.invoke('thread.create', { projectPath: projects[0].path }).then((thread) => {
          useThreadsStore.getState().upsertThread(thread);
          useUiStore.getState().showThreadTab();
          useThreadsStore.getState().selectThread(thread.id);
          useUnreadStore.getState().markRead(thread.id);
        });
      } else if (key === 'o') {
        e.preventDefault();
        void window.kydog.invoke('project.open').then((p) => {
          useThreadsStore.setState((s) => ({
            projects: [...s.projects.filter((x) => x.path !== p.path), p],
          }));
        }).catch((err) => console.error('open project failed', err));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-full flex flex-col">
      <ThemeApplier />
      <ReadingFontSizeApplier />
      <TitleBar title={currentTitle} />
      <UpdateBanner />
      <div className="flex-1 min-h-0">
        <ThreeColumnLayout
          left={<ErrorBoundary fallbackLabel="工作区出错"><WorkspacePanel /></ErrorBoundary>}
          center={<ErrorBoundary fallbackLabel="主内容区出错"><MainPane /></ErrorBoundary>}
          right={<ErrorBoundary fallbackLabel="检视区出错"><InspectorPanel /></ErrorBoundary>}
        />
      </div>
      {skillSync && (
        <SkillSyncModal
          status={skillSync}
          onApply={(ops) => window.kydog.invoke('skill.applyOverrides', { operations: ops }).then(setSkillSync)}
          onDismiss={() => setSkillSync(null)}
        />
      )}
      <ConfirmHost />
    </div>
  );
}
