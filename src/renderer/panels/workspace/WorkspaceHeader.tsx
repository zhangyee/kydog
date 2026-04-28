import { KyLogo } from './KyLogo';
import { CollapseButton } from './CollapseButton';

export function WorkspaceHeader() {
  return (
    <div className="h-10 px-3 flex items-center justify-between">
      <KyLogo />
      <CollapseButton target="workspace" />
    </div>
  );
}
