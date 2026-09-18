import { NavPill } from './NavPill';
import { useUiStore } from '../../stores/uiStore';

export function ActionPills() {
  const openSkills = () => useUiStore.getState().openSettings('skills');
  const openLongTermMemory = () => useUiStore.getState().openSettings('longTermMemory');
  return (
    <div className="flex flex-col gap-px" style={{ padding: '2px 6px 4px' }}>
      <NavPill icon="sparkles" label="技能和工具" testId="nav-skills" onClick={openSkills} />
      <NavPill icon="brain"  label="长期记忆"     testId="nav-long-term-memory" onClick={openLongTermMemory} />
      <NavPill icon="search" label="搜索"         shortcut="⌘G" testId="nav-search" disabled />
    </div>
  );
}
