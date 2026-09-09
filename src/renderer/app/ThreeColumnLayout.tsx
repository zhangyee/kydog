import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useUiStore } from '../stores/uiStore';

/**
 * `inspector` 与 `browser` 是**右栏那块地的两个占用者**，同一时刻只有一个在。
 *
 * 两个节点都从这里收，而不是让 AppShell 先挑好再传一个 `right` 进来：挑哪个组件
 * 与用哪一份宽度／收起状态必须是**同一个判断**。分在两个文件里的话，「浏览器开着
 * 却按 Inspector 的宽度排版」是一个编译得过、也不会有用例红的状态。
 */
type Props = { left: ReactNode; center: ReactNode; inspector: ReactNode; browser: ReactNode };

export function ThreeColumnLayout({ left, center, inspector, browser }: Props) {
  const wsCol = useUiStore((s) => s.workspaceCollapsed);
  const insCol = useUiStore((s) => s.inspectorCollapsed);
  const wsWidth = useUiStore((s) => s.workspaceWidth);
  const insWidth = useUiStore((s) => s.inspectorWidth);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const browserWidth = useUiStore((s) => s.browserWidth);

  // 浏览器开着时右栏一定是展开的 —— 它自己没有「收起成一条竖轨」那一档，
  // 收起就是关掉（标题栏那个地球，或者侧栏头上那个按钮）。
  // **`inspectorCollapsed` 不跟着改**：关掉浏览器时 Inspector 要回到用户上次留下的样子。
  const rightCollapsed = browserOpen ? false : insCol;
  const rightWidth = browserOpen ? browserWidth : insWidth;

  const cols = [
    wsCol ? '24px' : `${wsWidth}px`,
    wsCol ? '0px' : '4px',
    '1fr',
    rightCollapsed ? '0px' : '4px',
    rightCollapsed ? '24px' : `${rightWidth}px`,
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
        hidden={rightCollapsed}
        side="right"
        getStart={() => {
          const s = useUiStore.getState();
          return s.browserOpen ? s.browserWidth : s.inspectorWidth;
        }}
        setWidth={(w) => {
          const s = useUiStore.getState();
          if (s.browserOpen) s.setBrowserWidth(w); else s.setInspectorWidth(w);
        }}
      />
      <aside
        data-pane={browserOpen ? 'browser' : 'inspector'}
        className="overflow-hidden border-l border-[color:var(--color-ink-hair)]"
      >{browserOpen ? browser : inspector}</aside>
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
