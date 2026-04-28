import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { InspectorHeader } from './InspectorHeader';
import { FileTree } from './FileTree';
import { CollapseButton } from '../workspace/CollapseButton';

export function InspectorPanel() {
  const collapsed = useUiStore((s) => s.inspectorCollapsed);
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const projectPath = useThreadsStore((s) => {
    const t = Object.values(s.threadsByProject).flat().find((x) => x.id === currentThreadId);
    return t?.projectPath ?? null;
  });
  if (collapsed) {
    return (
      <div className="h-full flex flex-col items-center pt-2">
        <CollapseButton target="inspector" />
      </div>
    );
  }
  return (
    <div className="h-full flex flex-col">
      <InspectorHeader />
      <div className="flex-1 overflow-hidden">
        {projectPath
          ? <FileTree projectPath={projectPath} />
          : <div className="px-3 py-2 text-xs font-mono text-[color:var(--color-ink-soft)]">未选中 Thread</div>}
      </div>
    </div>
  );
}
