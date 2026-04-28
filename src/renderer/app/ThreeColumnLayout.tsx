import type { ReactNode } from 'react';
import { useUiStore } from '../stores/uiStore';

type Props = { left: ReactNode; center: ReactNode; right: ReactNode };

export function ThreeColumnLayout({ left, center, right }: Props) {
  const wsCol = useUiStore((s) => s.workspaceCollapsed);
  const insCol = useUiStore((s) => s.inspectorCollapsed);
  const cols = `${wsCol ? '24px' : '260px'} 1fr ${insCol ? '24px' : '260px'}`;
  return (
    <div className="h-full grid" style={{ gridTemplateColumns: cols }}>
      <aside data-pane="workspace" className="border-r border-[color:var(--color-paper-edge)] overflow-hidden">{left}</aside>
      <main data-pane="main" className="overflow-hidden">{center}</main>
      <aside data-pane="inspector" className="border-l border-[color:var(--color-paper-edge)] overflow-hidden">{right}</aside>
    </div>
  );
}
