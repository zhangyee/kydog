import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { CollapsedRail } from '../../app/CollapsedRail';
import { InspectorHeader } from './InspectorHeader';
import { FileTree } from './FileTree';

export function InspectorPanel() {
  const collapsed = useUiStore((s) => s.inspectorCollapsed);
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const projectPath = useThreadsStore((s) => {
    const t = Object.values(s.threadsByProject).flat().find((x) => x.id === currentThreadId);
    return t?.projectPath ?? null;
  });
  if (collapsed) {
    return <CollapsedRail side="right" label="Inspector" onOpen={useUiStore.getState().toggleInspector} testId="collapse-inspector" />;
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
