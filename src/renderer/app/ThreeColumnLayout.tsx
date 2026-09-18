import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useUiStore } from '../stores/uiStore';
import { rightPaneLayout, availableForCenterAndRight } from './rightPane';

/**
 * `inspector` 与 `browser` 是**右栏那块地的两个占用者**，同一时刻只有一个在。
 *
 * 两个节点都从这里收，而不是让 AppShell 先挑好再传一个 `right` 进来：挑哪个组件
 * 与用哪一份宽度／收起状态必须是**同一个判断**。分在两个文件里的话，「浏览器开着
 * 却按 Inspector 的宽度排版」是一个编译得过、也不会有用例红的状态。
 */
type Props = { left: ReactNode; center: ReactNode; inspector: ReactNode; browser: ReactNode };

/**
 * 拖右边那条手柄时用的判据。**不在组件里挂 ref 去量根节点宽度** —— `windowWidth`
 * 来自 `uiStore`（由 `bootstrap.ts` 的 resize 监听维护），组件本身不量任何东西：
 * 这份 vitest 跑在 `environment: 'node'`，没有 `window` 也没有 `ResizeObserver`，
 * 挂了就当场抛，而 `ThreeColumnLayout.test.tsx` 正靠真挂载组件守两条历史变异。
 */
function readRightPaneState() {
  const s = useUiStore.getState();
  return {
    browserOpen: s.browserOpen, browserWidth: s.browserWidth, browserFullscreen: s.browserFullscreen,
    inspectorCollapsed: s.inspectorCollapsed, inspectorWidth: s.inspectorWidth,
    availableWidth: availableForCenterAndRight(s.windowWidth, s.workspaceCollapsed, s.workspaceWidth),
  };
}

export function ThreeColumnLayout({ left, center, inspector, browser }: Props) {
  const wsCol = useUiStore((s) => s.workspaceCollapsed);
  const insCol = useUiStore((s) => s.inspectorCollapsed);
  const wsWidth = useUiStore((s) => s.workspaceWidth);
  const insWidth = useUiStore((s) => s.inspectorWidth);
  const browserOpen = useUiStore((s) => s.browserOpen);
  const browserWidth = useUiStore((s) => s.browserWidth);
  const browserFullscreen = useUiStore((s) => s.browserFullscreen);
  const windowWidth = useUiStore((s) => s.windowWidth);

  // 归谁、多宽、收没收起、中栏藏没藏是**同一个判断**，整个在 rightPane.ts（那边有用例）——
  // 拆在这里的话，「浏览器开着却按 Inspector 的宽度排版」三条 gate 全绿，实测过。
  const right = rightPaneLayout({
    browserOpen, browserWidth, browserFullscreen,
    inspectorCollapsed: insCol, inspectorWidth: insWidth,
    availableWidth: availableForCenterAndRight(windowWidth, wsCol, wsWidth),
  });

  const cols = [
    wsCol ? '24px' : `${wsWidth}px`,
    wsCol ? '0px' : '4px',
    right.centerHidden ? '0px' : '1fr',
    // 全屏时中栏是 0px，把手夹在两个格子之间没有意义、也拖不动。
    right.centerHidden ? '0px' : (right.collapsed ? '0px' : '4px'),
    right.centerHidden ? '1fr' : (right.collapsed ? '24px' : `${right.width}px`),
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
