import { WorkspaceHeader } from './WorkspaceHeader';
import { UserBar } from './UserBar';
import { UserMenuPopover } from './UserMenuPopover';

export function WorkspacePanel() {
  return (
    <div className="h-full flex flex-col relative">
      <WorkspaceHeader />
      <div className="flex-1" data-testid="workspace-body" />
      <UserBar />
      <UserMenuPopover />
    </div>
  );
}
