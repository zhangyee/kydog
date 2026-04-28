import { useUiStore } from '../../stores/uiStore';
import { CollapsedRail } from '../../app/CollapsedRail';
import { WorkspaceHeader } from './WorkspaceHeader';
import { OpenFolderButton } from './OpenFolderButton';
import { NewThreadButton } from './NewThreadButton';
import { ProjectsTree } from './ProjectsTree';
import { UserBar } from './UserBar';
import { UserMenuPopover } from './UserMenuPopover';

export function WorkspacePanel() {
  const collapsed = useUiStore((s) => s.workspaceCollapsed);
  if (collapsed) {
    return <CollapsedRail side="left" label="Workspace" onOpen={useUiStore.getState().toggleWorkspace} testId="collapse-workspace" />;
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
