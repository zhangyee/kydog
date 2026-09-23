import { useLayoutEffect, useRef } from 'react';
import { NavIcon, type NavIconName } from '../../shared';

export type TabKind = 'thread' | 'md' | 'pdf' | 'html' | 'settings';
export type TabItem = { id: string; kind: TabKind; title: string; dirty?: boolean; badge?: number };

type Props = {
  tabs: TabItem[];
  activeId: string | null;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
};

const KIND_COLOR: Record<TabKind, string> = {
  thread: 'var(--color-ink-soft)',
  md: 'var(--color-marginalia)',
  pdf: 'var(--color-accent)',
  html: 'var(--color-ink-soft)',
  settings: 'var(--color-ink-soft)',
};

const KIND_ICON: Record<TabKind, NavIconName> = {
  thread: 'messages-square',
  md: 'file-text',
  pdf: 'book-open-text',
  html: 'file-diff',
  settings: 'settings-2',
};

/**
 * 切换右侧标签（也包括刚打开的新文件）后，把活动项完整带回滚动区的可视范围。
 * thread 不走这里：它住在滚动区外的固定槽里，始终可见。
 */
export function revealActiveTab(tab: Pick<HTMLElement, 'scrollIntoView'> | null): void {
  tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

export function TabStrip({ tabs, activeId, onSelect, onClose }: Props) {
  const activeTabRef = useRef<HTMLDivElement>(null);
  const threadTabs = tabs.filter((t) => t.kind === 'thread');
  const scrollingTabs = tabs.filter((t) => t.kind !== 'thread');
  const activeIsScrollable = scrollingTabs.some((t) => t.id === activeId);

  useLayoutEffect(() => {
    // miniReact 的宿主替身刻意不实现真实 DOM 滚动；成品里的 HTMLDivElement 一定有这个方法。
    if (activeIsScrollable && typeof activeTabRef.current?.scrollIntoView === 'function') {
      revealActiveTab(activeTabRef.current);
    }
  }, [activeId, tabs.length, activeIsScrollable]);

  const renderTab = (t: TabItem, pinned: boolean) => {
    const isActive = t.id === activeId;
    return (
      <div
        key={t.id}
        ref={!pinned && isActive ? activeTabRef : undefined}
        data-testid={`tab-${t.id}`}
        onClick={() => onSelect?.(t.id)}
        className="flex items-center gap-2 cursor-pointer h-full min-w-0"
        style={{
          // 右侧 tab 从舒适宽度一起收窄，到 120px 后改为滚动。固定槽已经替 thread
          // 预留了自己的宽度，因此文件再多也不会把它卷走。
          flex: pinned ? '1 1 0' : '1 1 220px',
          minWidth: pinned ? 0 : 120,
          maxWidth: pinned ? 'none' : 220,
          overflow: 'hidden',
          padding: '0 14px 0 12px',
          background: isActive ? 'var(--color-paper)' : 'transparent',
          borderRight: pinned ? 'none' : '0.5px solid var(--color-ink-hair)',
          borderTop: `1.5px solid ${isActive ? 'var(--color-accent)' : 'transparent'}`,
          fontFamily: 'var(--font-sans)',
          fontSize: 12,
          color: isActive ? 'var(--color-ink)' : 'var(--color-ink-soft)',
          fontWeight: isActive ? 500 : 400,
        }}
      >
        <span className="shrink-0" style={{ color: KIND_COLOR[t.kind] }}>
          <NavIcon name={KIND_ICON[t.kind]} size={13} />
        </span>
        <span data-testid={`tab-title-${t.id}`} className="truncate flex-1 min-w-0">{t.title}</span>
        {t.badge ? (
          <span data-testid={`tab-badge-${t.id}`} className="font-mono shrink-0" style={{ fontSize: 10, color: 'var(--color-ink-faint)' }}>
            {t.badge}
          </span>
        ) : null}
        {t.dirty && (
          <span
            data-testid={`tab-dirty-${t.id}`}
            className="shrink-0"
            style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-accent)' }}
          />
        )}
        <button
          type="button"
          data-testid={`tab-close-${t.id}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose?.(t.id);
          }}
          className="ml-1 shrink-0"
          style={{ color: 'var(--color-ink-faint)', fontSize: 12 }}
          aria-label="关闭 Tab"
        >
          ×
        </button>
      </div>
    );
  };

  return (
    <div
      data-testid="main-tabstrip"
      className="ky-paper-deep flex shrink-0 min-w-0 overflow-hidden"
      style={{
        height: 34,
        borderBottom: '0.5px solid var(--color-ink-hair)',
        paddingLeft: 2,
      }}
    >
      {threadTabs.length > 0 && (
        <div
          data-testid="main-tabpinned"
          className="ky-paper-deep flex shrink min-w-0 h-full"
          style={{
            flexBasis: 220,
            minWidth: 140,
            maxWidth: 220,
            borderRight: '0.5px solid var(--color-ink-hair)',
            boxShadow: '2px 0 5px var(--color-card-shadow-strong)',
            zIndex: 1,
          }}
        >
          {threadTabs.map((t) => renderTab(t, true))}
        </div>
      )}
      <div
        data-testid="main-tabscroll"
        className="ky-tab-scroll flex flex-1 min-w-0 overflow-x-auto overflow-y-hidden h-full"
        style={{ minWidth: threadTabs.length > 0 ? 120 : 0 }}
      >
        {scrollingTabs.map((t) => renderTab(t, false))}
        <div className="flex-1 shrink-0" />
      </div>
    </div>
  );
}
