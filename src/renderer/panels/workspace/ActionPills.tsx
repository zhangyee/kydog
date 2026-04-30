import { NavPill } from './NavPill';

export function ActionPills() {
  return (
    <div className="flex flex-col gap-px" style={{ padding: '2px 6px 4px' }}>
      <NavPill icon="sparkles" label="技能和工具" testId="nav-skills" disabled />
      <NavPill icon="brain"  label="长期记忆"     testId="nav-memory" disabled />
      <NavPill icon="search" label="搜索"         shortcut="⌘G" testId="nav-search" disabled />
    </div>
  );
}
