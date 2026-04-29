import type { ReactNode } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { Welcome } from './Welcome';
import { ThreadView } from './ThreadView';
import { TabStrip, type TabItem } from './TabStrip';
import { SettingsPane } from '../../settings/SettingsPane';
import { SETTINGS_PAGE_LABELS } from '../../settings/settingsPages';

const SETTINGS_TAB_ID = '__settings__';

export function MainPane() {
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const select = useThreadsStore((s) => s.selectThread);
  const settingsTabOpen = useUiStore((s) => s.settingsTabOpen);
  const settingsTab = useUiStore((s) => s.settingsTab);
  const activeCenterTab = useUiStore((s) => s.activeCenterTab);
  const showThreadTab = useUiStore((s) => s.showThreadTab);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const thread = useThreadsStore((s) =>
    currentThreadId
      ? Object.values(s.threadsByProject).flat().find((t) => t.id === currentThreadId)
      : null,
  );

  let content: ReactNode;
  let tabs: TabItem[] = [];
  const showSettings = settingsTabOpen && (activeCenterTab === 'settings' || !thread);

  if (thread) {
    tabs.push({ id: thread.id, kind: 'thread', title: thread.title });
  }
  if (settingsTabOpen) {
    tabs.push({ id: SETTINGS_TAB_ID, kind: 'settings', title: SETTINGS_PAGE_LABELS[settingsTab] });
  }

  if (showSettings) {
    content = <SettingsPane />;
  } else if (currentThreadId && thread) {
    content = <ThreadView threadId={thread.id} />;
  } else {
    content = <Welcome />;
  }

  return (
    <div className="h-full flex flex-col bg-[color:var(--color-paper)]">
      {tabs.length > 0 && (
        <TabStrip
          tabs={tabs}
          activeId={showSettings ? SETTINGS_TAB_ID : currentThreadId}
          onSelect={(id) => {
            if (id === SETTINGS_TAB_ID) {
              useUiStore.getState().openSettings(useUiStore.getState().settingsTab);
              return;
            }
            showThreadTab();
            select(id);
          }}
          onClose={(id) => {
            if (id === SETTINGS_TAB_ID) {
              closeSettings();
              return;
            }
            select(null);
            if (settingsTabOpen) useUiStore.getState().openSettings(useUiStore.getState().settingsTab);
          }}
        />
      )}
      <div className="flex-1 min-h-0 flex flex-col">{content}</div>
    </div>
  );
}
