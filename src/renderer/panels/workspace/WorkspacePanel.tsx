import { useUiStore } from '../../stores/uiStore';
import { WorkspaceHeader } from './WorkspaceHeader';
import { OpenFolderButton } from './OpenFolderButton';
import { NewThreadButton } from './NewThreadButton';
import { ProjectsTree } from './ProjectsTree';
import { UserBar } from './UserBar';
import { UserMenuPopover } from './UserMenuPopover';
import { CollapseButton } from './CollapseButton';

export function WorkspacePanel() {
  const collapsed = useUiStore((s) => s.workspaceCollapsed);
  if (collapsed) {
    return (
      <div className="h-full flex flex-col items-center pt-2">
        <CollapseButton target="workspace" />
      </div>
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
