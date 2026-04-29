import { NavPill } from './NavPill';

export function ActionPills() {
  return (
    <div className="flex flex-col gap-px" style={{ padding: '12px 6px 4px' }}>
      <NavPill icon="auto"   label="Skills & CLI" count={12} testId="nav-skills"  disabled />
      <NavPill icon="brain"  label="长期记忆"     testId="nav-memory" disabled />
      <NavPill icon="search" label="搜索"         testId="nav-search" disabled />
    </div>
  );
}
