import { useThreadsStore } from '../../stores/threadsStore';
import { NavPill } from './NavPill';

export function NewThreadButton() {
  const projects = useThreadsStore((s) => s.projects);
  const upsert = useThreadsStore((s) => s.upsertThread);
  const select = useThreadsStore((s) => s.selectThread);
  const enabled = projects.length > 0;
  const onClick = async () => {
    if (!enabled) return;
    const projectPath = projects[0].path;   // A2 简化：第一个 project；后续 phase 从树点击决定
    const thread = await window.kydog.invoke('thread.create', { projectPath });
    upsert(thread);
    select(thread.id);
  };
  return (
    <div style={{ padding: '10px 6px 0' }}>
      <NavPill
        icon="compose"
        label="新对话"
        shortcut="⌘N"
        onClick={onClick}
        disabled={!enabled}
        testId="new-thread"
      />
    </div>
  );
}
