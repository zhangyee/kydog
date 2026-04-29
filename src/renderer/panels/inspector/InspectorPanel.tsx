import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { CollapsedRail } from '../../app/CollapsedRail';
import { InspectorHeader } from './InspectorHeader';
import { ProjectCard } from './ProjectCard';
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
    <div className="ky-paper-deep h-full flex flex-col">
      <InspectorHeader />
      {projectPath ? (
        <>
          <ProjectCard projectPath={projectPath} />
          <div style={{ padding: '10px 14px 4px' }}>
            <div
              className="font-mono uppercase"
              style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-ink-faint)', letterSpacing: 1, marginBottom: 4 }}
            >文件</div>
          </div>
          <div className="flex-1 overflow-hidden">
            <FileTree projectPath={projectPath} />
          </div>
        </>
      ) : (
        <div className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--color-ink-soft)' }}>未选中 Thread</div>
      )}
    </div>
  );
}
