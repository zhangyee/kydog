import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useUiStore } from '../stores/uiStore';
import { rightPaneLayout } from './rightPane';

/**
 * `inspector` 与 `browser` 是**右栏那块地的两个占用者**，同一时刻只有一个在。
 *
 * 两个节点都从这里收，而不是让 AppShell 先挑好再传一个 `right` 进来：挑哪个组件
 * 与用哪一份宽度／收起状态必须是**同一个判断**。分在两个文件里的话，「浏览器开着
 * 却按 Inspector 的宽度排版」是一个编译得过、也不会有用例红的状态。
 */
type Props = { left: ReactNode; center: ReactNode; inspector: ReactNode; browser: ReactNode };

/**
 * `rightPaneLayout` 的 `browserFullscreen` 与 `availableWidth` 这一轮还没接线（那是
 * Task 2 的事）。**占位不用 `window.innerWidth`**：一是单测在 `node` 环境跑、没有
 * `window`，二是接一个真实宽度会让 `browserWidthFor` 的下限钳制提前生效，改掉现在
 * 「浏览器栏就是 `browserWidth` 本身」这个行为——那不是这一轮该碰的。用一个大到
 * 钳制不了任何现实宽度的占位值，两边都不动。
 */
const PLACEHOLDER_AVAILABLE_WIDTH = 100_000;

function readRightPaneState() {
  const s = useUiStore.getState();
  return {
    browserOpen: s.browserOpen, browserWidth: s.browserWidth, browserFullscreen: false,
    inspectorCollapsed: s.inspectorCollapsed, inspectorWidth: s.inspectorWidth,
    availableWidth: PLACEHOLDER_AVAILABLE_WIDTH,
  };
}

export function ThreeColumnLayout({ left, center, inspector, browser }: Props) {
  const wsCol = useUiStore((s) => s.workspaceCollapsed);
  const insCol = useUiStore((s) => s.inspectorCollapsed);
  const wsWidth = useUiStore((s) => s.workspaceWidth);
  const insWidth = useUiStore((s) => s.inspectorWidth);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const browserWidth = useUiStore((s) => s.browserWidth);

  // 归谁、多宽、收没收起、中栏藏没藏是**同一个判断**，整个在 rightPane.ts（那边有用例）——
  // 拆在这里的话，「浏览器开着却按 Inspector 的宽度排版」三条 gate 全绿，实测过。
  // browserFullscreen 与 availableWidth 这一轮先占位，见 PLACEHOLDER_AVAILABLE_WIDTH 的注释——
  // 真正接线是 Task 2。
  const right = rightPaneLayout({
    browserOpen, browserWidth, browserFullscreen: false,
    inspectorCollapsed: insCol, inspectorWidth: insWidth,
    availableWidth: PLACEHOLDER_AVAILABLE_WIDTH,
  });

  const cols = [
    wsCol ? '24px' : `${wsWidth}px`,
    wsCol ? '0px' : '4px',
    '1fr',
    right.collapsed ? '0px' : '4px',
    right.collapsed ? '24px' : `${right.width}px`,
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
        hidden={right.collapsed}
        side="right"
        getStart={() => rightPaneLayout(readRightPaneState()).width}
        setWidth={(w) => {
          const s = useUiStore.getState();
          // 拖的是哪一栏，判据与上面排版用的是同一个函数，不在这里再写一遍。
          if (rightPaneLayout(readRightPaneState()).mode === 'browser') s.setBrowserWidth(w); else s.setInspectorWidth(w);
        }}
      />
      <aside
        data-pane={right.mode}
        className="overflow-hidden border-l border-[color:var(--color-ink-hair)]"
      >{right.mode === 'browser' ? browser : inspector}</aside>
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
