import { useUiStore } from '../../stores/uiStore';
import { CollapsedRail } from '../../app/CollapsedRail';
import { WorkspaceHeader } from './WorkspaceHeader';
import { NewThreadButton } from './NewThreadButton';
import { ActionPills } from './ActionPills';
import { ProjectsTree } from './ProjectsTree';
import { UserBar } from './UserBar';
import { UserMenuPopover } from './UserMenuPopover';

export function WorkspacePanel() {
  const collapsed = useUiStore((s) => s.workspaceCollapsed);
  if (collapsed) {
    return <CollapsedRail side="left" label="Workspace" onOpen={useUiStore.getState().toggleWorkspace} testId="collapse-workspace" />;
  }
  return (
    <div className="ky-paper-deep h-full flex flex-col relative">
      <WorkspaceHeader />
      <NewThreadButton />
      <ActionPills />
      <div className="flex-1 overflow-y-auto ky-scroll" style={{ paddingBottom: 8 }}>
        <ProjectsTree />
      </div>
      <UserBar />
      <UserMenuPopover />
    </div>
  );
}
