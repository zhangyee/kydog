import { useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { CollapsedRail } from '../../app/CollapsedRail';
import { WorkspaceHeader } from './WorkspaceHeader';
import { NewThreadButton } from './NewThreadButton';
import { ActionPills } from './ActionPills';
import { ProjectsTree } from './ProjectsTree';
import { UserBar } from './UserBar';
import { UserMenuPopover } from './UserMenuPopover';
import { SidebarToast } from './SidebarToast';
import { useSidebarSelection } from './sidebarSelection';

export function WorkspacePanel() {
  const collapsed = useUiStore((s) => s.workspaceCollapsed);
  const hasSelection = useSidebarSelection((s) => s.selectedIds.length >= 2);

  // 多选态才挂 Esc。右键菜单的 Esc 在 window 捕获阶段 preventDefault，这里（冒泡阶段）跳过那一下：
  // 菜单开着时第一下 Esc 只关菜单，第二下才清多选（spec 2026-09-21-thread-archive-design §4.4）。
  useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      useSidebarSelection.getState().clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasSelection]);

  if (collapsed) {
    return <CollapsedRail side="left" label="Workspace" onOpen={useUiStore.getState().toggleWorkspace} testId="collapse-workspace" />;
  }
  return (
    <div className="ky-paper-deep h-full flex flex-col relative">
      <WorkspaceHeader />
      <NewThreadButton />
      <ActionPills />
      <div className="flex-1 overflow-x-hidden overflow-y-auto ky-scroll" style={{ paddingBottom: 8 }}>
        <ProjectsTree />
      </div>
      <SidebarToast />
      <UserBar />
      <UserMenuPopover />
    </div>
  );
}
