import { useCallback, useEffect, useState } from 'react';
import { ThemeApplier } from './ThemeApplier';
import { ReadingFontSizeApplier } from './ReadingFontSizeApplier';
import { TitleBar } from './TitleBar';
import { UpdateBanner } from './UpdateBanner';
import { ThreeColumnLayout } from './ThreeColumnLayout';
import { ErrorBoundary } from './ErrorBoundary';
import { ConfirmHost } from './ConfirmHost';
import { HarnessUpdateDialog } from './HarnessUpdateDialog';
import { WorkspacePanel } from '../panels/workspace/WorkspacePanel';
import { MainPane } from '../panels/main-pane/MainPane';
import { InspectorPanel } from '../panels/inspector/InspectorPanel';
import { BrowserSidebar } from '../panels/browser/BrowserSidebar';
import { useThreadsStore } from '../stores/threadsStore';
import { useUiStore } from '../stores/uiStore';
import { startNewThreadInFocusedProject } from '../newThread';
import { SETTINGS_PAGE_LABELS } from '../settings/settingsPages';

export function AppShell() {
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

  // 启动时的模板更新询问查完了没有、查成了没有（spec §4）。挂在根节点上给 e2e 当正向记号：
  // 断「对话框不在」之前先等 done，不然查询还没回来，断言就已经通过了。
  const [harnessCheck, setHarnessCheck] = useState<'pending' | 'done' | 'failed'>('pending');
  const onHarnessChecked = useCallback((ok: boolean) => setHarnessCheck(ok ? 'done' : 'failed'), []);

  // ⌘N → new thread, ⌘O → open project folder. 聚焦输入框时不拦截。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === 'n') {
        e.preventDefault();
        void startNewThreadInFocusedProject();
      } else if (key === 'o') {
        e.preventDefault();
        void window.kydog.invoke('project.open').then((p) => {
          useThreadsStore.getState().addProject(p);
        }).catch((err) => console.error('open project failed', err));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-full flex flex-col" data-harness-check={harnessCheck}>
      <ThemeApplier />
      <ReadingFontSizeApplier />
      <TitleBar title={currentTitle} />
      <UpdateBanner />
      <div className="flex-1 min-h-0">
        <ThreeColumnLayout
          left={<ErrorBoundary fallbackLabel="工作区出错"><WorkspacePanel /></ErrorBoundary>}
          center={<ErrorBoundary fallbackLabel="主内容区出错"><MainPane /></ErrorBoundary>}
          inspector={<ErrorBoundary fallbackLabel="检视区出错"><InspectorPanel /></ErrorBoundary>}
          browser={<ErrorBoundary fallbackLabel="浏览器侧栏出错"><BrowserSidebar /></ErrorBoundary>}
        />
      </div>
      <HarnessUpdateDialog onSettled={onHarnessChecked} />
      <ConfirmHost />
    </div>
  );
}
