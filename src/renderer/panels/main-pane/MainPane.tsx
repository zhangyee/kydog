import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { useUnreadStore } from '../workspace/unreadStore';
import { useComposerDraftStore } from './composerDraftStore';
import { Welcome } from './Welcome';
import { ThreadView } from './ThreadView';
import { TabStrip, type TabItem } from './TabStrip';
import { SettingsPane } from '../../settings/SettingsPane';
import { SETTINGS_PAGE_LABELS } from '../../settings/settingsPages';
import { MarkdownFileTab } from './markdown/MarkdownFileTab';
import { PdfFileTab } from './pdf/PdfFileTab';
import { HtmlFileTab } from './html/HtmlFileTab';
import { UnsavedChangesModal } from './markdown/UnsavedChangesModal';
import { getSaver } from './markdown/saveRegistry';

const SETTINGS_TAB_ID = '__settings__';

/** 关完目标之后再读一次真 store；脏文件提示期间用户可能已经从侧栏打开了别的 tab。 */
function hasVisibleCenterTabs(): boolean {
  const ui = useUiStore.getState();
  const threads = useThreadsStore.getState();
  const hasThread = threads.currentThreadId !== null
    && Object.values(threads.threadsByProject).flat().some((t) => t.id === threads.currentThreadId);
  return hasThread || ui.settingsTabOpen || ui.openFileTabs.length > 0;
}

function closeWindowIfEmpty(): void {
  if (!hasVisibleCenterTabs()) void window.kydog.invoke('window.close');
}

export function MainPane() {
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const select = useThreadsStore((s) => s.selectThread);
  const settingsTabOpen = useUiStore((s) => s.settingsTabOpen);
  const settingsTab = useUiStore((s) => s.settingsTab);
  const activeCenterTab = useUiStore((s) => s.activeCenterTab);
  const showThreadTab = useUiStore((s) => s.showThreadTab);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const openFileTabs = useUiStore((s) => s.openFileTabs);
  const activeFileTabId = useUiStore((s) => s.activeFileTabId);
  const focusFileTab = useUiStore((s) => s.focusFileTab);
  const closeFileTab = useUiStore((s) => s.closeFileTab);
  const closeActiveTabRequests = useUiStore((s) => s.closeActiveTabRequests);
  const consumeCloseActiveTabRequest = useUiStore((s) => s.consumeCloseActiveTabRequest);
  const thread = useThreadsStore((s) =>
    currentThreadId
      ? Object.values(s.threadsByProject).flat().find((t) => t.id === currentThreadId)
      : null,
  );
  // 对话标签上的待发批注数（2A ①）。只数批注：附件是在对话里当场加的，不需要提醒。
  const pendingComments = useComposerDraftStore((s) => (currentThreadId ? s.byThread[currentThreadId]?.comments.length ?? 0 : 0));

  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);

  useEffect(() => {
    if (pendingCloseId && !openFileTabs.some((t) => t.id === pendingCloseId)) {
      setPendingCloseId(null);
    }
  }, [openFileTabs, pendingCloseId]);

  const showFile = activeCenterTab === 'file'
    && activeFileTabId !== null
    && openFileTabs.some((t) => t.id === activeFileTabId);
  const showSettings = !showFile && settingsTabOpen && (activeCenterTab === 'settings' || !thread);

  const tabs: TabItem[] = [];
  if (thread) tabs.push({ id: thread.id, kind: 'thread', title: thread.title, ...(pendingComments > 0 ? { badge: pendingComments } : {}) });
  if (settingsTabOpen) {
    tabs.push({ id: SETTINGS_TAB_ID, kind: 'settings', title: SETTINGS_PAGE_LABELS[settingsTab] });
  }
  for (const ft of openFileTabs) {
    tabs.push({ id: ft.id, kind: ft.kind, title: ft.title, dirty: ft.dirty });
  }

  let activeId: string | null;
  if (showFile) activeId = activeFileTabId;
  else if (showSettings) activeId = SETTINGS_TAB_ID;
  else activeId = currentThreadId;

  let nonFileContent: ReactNode = null;
  if (!showFile) {
    if (showSettings) nonFileContent = <SettingsPane />;
    else if (currentThreadId && thread) nonFileContent = <ThreadView threadId={thread.id} />;
    else nonFileContent = <Welcome />;
  }

  const requestCloseTab = useCallback((id: string) => {
    if (id === SETTINGS_TAB_ID) {
      closeSettings();
      closeWindowIfEmpty();
      return;
    }
    const file = useUiStore.getState().openFileTabs.find((t) => t.id === id);
    if (file) {
      if (file.dirty) {
        setPendingCloseId(id);
        return;
      }
      closeFileTab(id);
      closeWindowIfEmpty();
      return;
    }
    select(null);
    if (useUiStore.getState().settingsTabOpen) {
      useUiStore.getState().openSettings(useUiStore.getState().settingsTab);
    }
    closeWindowIfEmpty();
  }, [closeFileTab, closeSettings, select]);

  useEffect(() => {
    if (closeActiveTabRequests <= 0) return;
    consumeCloseActiveTabRequest();
    if (activeId === null) closeWindowIfEmpty();
    else requestCloseTab(activeId);
  }, [activeId, closeActiveTabRequests, consumeCloseActiveTabRequest, requestCloseTab]);

  const pendingTab = pendingCloseId
    ? openFileTabs.find((t) => t.id === pendingCloseId) ?? null
    : null;

  return (
    <div className="h-full flex flex-col bg-[color:var(--color-paper)]">
      {tabs.length > 0 && (
        <TabStrip
          tabs={tabs}
          activeId={activeId}
          onSelect={(id) => {
            if (id === SETTINGS_TAB_ID) {
              useUiStore.getState().openSettings(useUiStore.getState().settingsTab);
              return;
            }
            if (openFileTabs.some((t) => t.id === id)) {
              focusFileTab(id);
              return;
            }
            showThreadTab();
            select(id);
            useUnreadStore.getState().markRead(id);
          }}
          onClose={(id) => {
            requestCloseTab(id);
          }}
        />
      )}
      <div className="flex-1 min-h-0 relative">
        {/* 文件编辑器：tab 打开期间始终挂载，display 控制可见 */}
        {openFileTabs.map((ft) => {
          const visible = showFile && ft.id === activeFileTabId;
          return (
            <div
              key={ft.id}
              data-testid={`file-pane-${ft.id}`}
              className="absolute inset-0 flex flex-col"
              style={{ display: visible ? 'flex' : 'none' }}
            >
              {ft.kind === 'pdf'
                ? <PdfFileTab tab={ft} />
                : ft.kind === 'html'
                  ? <HtmlFileTab tab={ft} isActive={visible} />
                  : <MarkdownFileTab tab={ft} isActive={visible} />}
            </div>
          );
        })}
        {/* 非文件内容 */}
        {!showFile && <div className="absolute inset-0 flex flex-col">{nonFileContent}</div>}
      </div>
      {pendingTab && (
        <UnsavedChangesModal
          fileTitle={pendingTab.title}
          onCancel={() => setPendingCloseId(null)}
          onDiscard={() => {
            closeFileTab(pendingTab.id);
            setPendingCloseId(null);
            closeWindowIfEmpty();
          }}
          onSave={() => {
            const saver = getSaver(pendingTab.id);
            const id = pendingTab.id;
            setPendingCloseId(null);
            if (!saver) {
              closeFileTab(id);
              closeWindowIfEmpty();
              return;
            }
            void saver().then((ok) => {
              if (!ok) return;
              closeFileTab(id);
              closeWindowIfEmpty();
            });
          }}
        />
      )}
    </div>
  );
}
