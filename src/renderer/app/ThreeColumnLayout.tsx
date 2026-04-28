import type { ReactNode } from 'react';
import { useUiStore } from '../stores/uiStore';

type Props = { left: ReactNode; center: ReactNode; right: ReactNode };

export function ThreeColumnLayout({ left, center, right }: Props) {
  const wsCol = useUiStore((s) => s.workspaceCollapsed);
  const insCol = useUiStore((s) => s.inspectorCollapsed);
  const cols = `${wsCol ? '24px' : '260px'} 1fr ${insCol ? '24px' : '280px'}`;
  return (
    <div className="h-full grid" style={{ gridTemplateColumns: cols, transition: 'grid-template-columns 180ms cubic-bezier(.2,.7,.3,1)' }}>
      <aside data-pane="workspace" className="overflow-hidden border-r border-[color:var(--color-ink-hair)]">{left}</aside>
      <main data-pane="main" className="overflow-hidden">{center}</main>
      <aside data-pane="inspector" className="overflow-hidden border-l border-[color:var(--color-ink-hair)]">{right}</aside>
    </div>
  );
}
