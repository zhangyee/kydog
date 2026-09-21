import { useThreadsStore } from '../../stores/threadsStore';
import { startNewThreadInFocusedProject } from '../../newThread';
import { NavPill } from './NavPill';

export function NewThreadButton() {
  const projects = useThreadsStore((s) => s.projects);
  const enabled = projects.length > 0;
  const onClick = async () => {
    if (!enabled) return;
    await startNewThreadInFocusedProject();
  };
  return (
    <div style={{ padding: '10px 6px 0' }}>
      <NavPill
        icon="square-pen"
        label="新对话"
        shortcut="⌘N"
        onClick={onClick}
        disabled={!enabled}
        testId="new-thread"
      />
    </div>
  );
}
