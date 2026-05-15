import { NavIcon, type NavIconName } from '../../shared';

export type TabKind = 'thread' | 'md' | 'pdf' | 'settings';
export type TabItem = { id: string; kind: TabKind; title: string; dirty?: boolean };

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
  settings: 'var(--color-ink-soft)',
};

const KIND_ICON: Record<TabKind, NavIconName> = {
  thread: 'messages-square',
  md: 'file-text',
  pdf: 'book-open-text',
  settings: 'settings-2',
};

export function TabStrip({ tabs, activeId, onSelect, onClose }: Props) {
  return (
    <div
      className="ky-paper-deep flex shrink-0"
      style={{ height: 34, borderBottom: '0.5px solid var(--color-ink-hair)', paddingLeft: 2 }}
    >
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        return (
          <div
            key={t.id}
            data-testid={`tab-${t.id}`}
            onClick={() => onSelect?.(t.id)}
            className="flex items-center gap-2 cursor-pointer h-full"
            style={{
              padding: '0 14px 0 12px',
              background: isActive ? 'var(--color-paper)' : 'transparent',
              borderRight: '0.5px solid var(--color-ink-hair)',
              borderTop: `1.5px solid ${isActive ? 'var(--color-accent)' : 'transparent'}`,
              fontFamily: 'var(--font-sans)',
              fontSize: 12,
              color: isActive ? 'var(--color-ink)' : 'var(--color-ink-soft)',
              fontWeight: isActive ? 500 : 400,
            }}
            >
            <span style={{ color: KIND_COLOR[t.kind] }}>
              <NavIcon name={KIND_ICON[t.kind]} size={13} />
            </span>
            <span className="truncate" style={{ maxWidth: 180 }}>{t.title}</span>
            {t.dirty && (
              <span
                data-testid={`tab-dirty-${t.id}`}
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
              className="ml-1"
              style={{ color: 'var(--color-ink-faint)', fontSize: 12 }}
              aria-label="关闭 Tab"
            >
              ×
            </button>
          </div>
        );
      })}
      <div className="flex-1" />
    </div>
  );
}
