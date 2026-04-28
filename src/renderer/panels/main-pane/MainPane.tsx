import type { ReactNode } from 'react';
import { useThreadsStore } from '../../stores/threadsStore';
import { Welcome } from './Welcome';
import { ThreadView } from './ThreadView';
import { TabStrip, type TabItem } from './TabStrip';

export function MainPane() {
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const select = useThreadsStore((s) => s.selectThread);
  const thread = useThreadsStore((s) =>
    currentThreadId
      ? Object.values(s.threadsByProject).flat().find((t) => t.id === currentThreadId)
      : null,
  );

  let content: ReactNode;
  let tabs: TabItem[] = [];
  if (currentThreadId && thread) {
    tabs = [{ id: thread.id, kind: 'thread', title: thread.title }];
    content = <ThreadView threadId={thread.id} />;
  } else {
    content = <Welcome />;
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--color-paper)' }}>
      {tabs.length > 0 && (
        <TabStrip
          tabs={tabs}
          activeId={currentThreadId}
          onSelect={(id) => select(id)}
          onClose={() => select(null)}
        />
      )}
      <div className="flex-1 min-h-0 flex flex-col">{content}</div>
    </div>
  );
}
