import { useEffect, useState, type ReactNode } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { useUnreadStore } from '../workspace/unreadStore';
import { Welcome } from './Welcome';
import { ThreadView } from './ThreadView';
import { TabStrip, type TabItem } from './TabStrip';
import { SettingsPane } from '../../settings/SettingsPane';
import { SETTINGS_PAGE_LABELS } from '../../settings/settingsPages';
import { MarkdownFileTab } from './markdown/MarkdownFileTab';
import { UnsavedChangesModal } from './markdown/UnsavedChangesModal';
import { getSaver } from './markdown/saveRegistry';

const SETTINGS_TAB_ID = '__settings__';

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
  const thread = useThreadsStore((s) =>
    currentThreadId
      ? Object.values(s.threadsByProject).flat().find((t) => t.id === currentThreadId)
      : null,
  );

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
  if (thread) tabs.push({ id: thread.id, kind: 'thread', title: thread.title });
  if (settingsTabOpen) {
    tabs.push({ id: SETTINGS_TAB_ID, kind: 'settings', title: SETTINGS_PAGE_LABELS[settingsTab] });
  }
  for (const ft of openFileTabs) {
    tabs.push({ id: ft.id, kind: 'md', title: ft.title, dirty: ft.dirty });
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

  const requestCloseFile = (id: string) => {
    const tab = openFileTabs.find((t) => t.id === id);
    if (tab?.dirty) setPendingCloseId(id);
    else closeFileTab(id);
  };

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
            if (id === SETTINGS_TAB_ID) {
              closeSettings();
              return;
            }
            if (openFileTabs.some((t) => t.id === id)) {
              requestCloseFile(id);
              return;
            }
            select(null);
            if (settingsTabOpen) useUiStore.getState().openSettings(useUiStore.getState().settingsTab);
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
              <MarkdownFileTab tab={ft} isActive={visible} />
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
          }}
          onSave={() => {
            const saver = getSaver(pendingTab.id);
            const id = pendingTab.id;
            setPendingCloseId(null);
            if (!saver) { closeFileTab(id); return; }
            void saver().then((ok) => { if (ok) closeFileTab(id); });
          }}
        />
      )}
    </div>
  );
}
