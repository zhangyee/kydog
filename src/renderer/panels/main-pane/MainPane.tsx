import { useThreadsStore } from '../../stores/threadsStore';
import { Welcome } from './Welcome';
import { ThreadView } from './ThreadView';

export function MainPane() {
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  if (!currentThreadId) return <Welcome />;
  return <ThreadView threadId={currentThreadId} />;
}
