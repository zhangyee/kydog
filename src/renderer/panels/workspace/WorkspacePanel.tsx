import { useUiStore } from '../../stores/uiStore';
import { WorkspaceHeader } from './WorkspaceHeader';
import { OpenFolderButton } from './OpenFolderButton';
import { NewThreadButton } from './NewThreadButton';
import { ProjectsTree } from './ProjectsTree';
import { UserBar } from './UserBar';
import { UserMenuPopover } from './UserMenuPopover';

export function WorkspacePanel() {
  const collapsed = useUiStore((s) => s.workspaceCollapsed);
  if (collapsed) {
    return (
      <button
        type="button"
        data-testid="collapse-workspace"
        aria-label="展开 workspace"
        onClick={useUiStore.getState().toggleWorkspace}
        className="h-full w-full flex items-start justify-center pt-2 text-xs text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)] hover:bg-[color:var(--color-paper-edge)]/40 cursor-pointer"
      >
        ⇥
      </button>
    );
  }
  return (
    <div className="h-full flex flex-col relative">
      <WorkspaceHeader />
      <OpenFolderButton />
      <NewThreadButton />
      <div className="flex-1 overflow-y-auto">
        <ProjectsTree />
      </div>
      <UserBar />
      <UserMenuPopover />
    </div>
  );
}
