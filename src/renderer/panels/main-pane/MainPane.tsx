import { useThreadsStore } from '../../stores/threadsStore';
import { Welcome } from './Welcome';

export function MainPane() {
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  if (!currentThreadId) return <Welcome />;
  return (
    <div className="h-full p-4 font-mono text-sm text-[color:var(--color-ink-soft)]" data-testid="thread-view-placeholder">
      Thread {currentThreadId} (Phase 2 fills in ThreadView)
    </div>
  );
}
