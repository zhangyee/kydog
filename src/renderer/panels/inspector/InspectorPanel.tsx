import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
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
    return (
      <button
        type="button"
        data-testid="collapse-inspector"
        aria-label="展开 inspector"
        onClick={useUiStore.getState().toggleInspector}
        className="h-full w-full flex items-start justify-center pt-4 cursor-pointer hover:bg-[color:var(--color-paper-edge)]/40"
      >
        <span
          className="font-mono text-[10px] tracking-[0.3em] text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)]"
          style={{ writingMode: 'vertical-rl' }}
        >
          INSPECTOR
        </span>
      </button>
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
