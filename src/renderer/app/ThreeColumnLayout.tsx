import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useUiStore } from '../stores/uiStore';

type Props = { left: ReactNode; center: ReactNode; right: ReactNode };

export function ThreeColumnLayout({ left, center, right }: Props) {
  const wsCol = useUiStore((s) => s.workspaceCollapsed);
  const insCol = useUiStore((s) => s.inspectorCollapsed);
  const wsWidth = useUiStore((s) => s.workspaceWidth);
  const insWidth = useUiStore((s) => s.inspectorWidth);

  const cols = [
    wsCol ? '24px' : `${wsWidth}px`,
    wsCol ? '0px' : '4px',
    '1fr',
    insCol ? '0px' : '4px',
    insCol ? '24px' : `${insWidth}px`,
  ].join(' ');

  return (
    <div className="h-full grid" style={{ gridTemplateColumns: cols }}>
      <aside data-pane="workspace" className="overflow-hidden border-r border-[color:var(--color-ink-hair)]">{left}</aside>
      <DragHandle
        hidden={wsCol}
        side="left"
        getStart={() => useUiStore.getState().workspaceWidth}
        setWidth={(w) => useUiStore.getState().setWorkspaceWidth(w)}
      />
      <main data-pane="main" className="overflow-hidden">{center}</main>
      <DragHandle
        hidden={insCol}
        side="right"
        getStart={() => useUiStore.getState().inspectorWidth}
        setWidth={(w) => useUiStore.getState().setInspectorWidth(w)}
      />
      <aside data-pane="inspector" className="overflow-hidden border-l border-[color:var(--color-ink-hair)]">{right}</aside>
    </div>
  );
}

type HandleProps = {
  hidden: boolean;
  side: 'left' | 'right';
  getStart: () => number;
  setWidth: (w: number) => void;
};

function DragHandle({ hidden, side, getStart, setWidth }: HandleProps) {
  if (hidden) return <div />;
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = getStart();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      setWidth(side === 'left' ? startW + dx : startW - dx);
    };
    const onUp = (ev: PointerEvent) => {
      target.releasePointerCapture(ev.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  return (
    <div
      data-testid={`resize-${side}`}
      onPointerDown={onPointerDown}
      className="cursor-col-resize relative group"
      style={{ background: 'transparent' }}
    >
      <div
        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover:bg-[color:var(--color-accent-soft)]"
      />
    </div>
  );
}
