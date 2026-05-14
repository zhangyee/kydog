import type { MouseEvent } from 'react';
import { NavIcon } from '../../shared';
import { useThreadsStore } from '../../stores/threadsStore';
import { useRunsStore } from '../../stores/runsStore';
import { useUnreadStore } from './unreadStore';
import { pickSlot } from './pickThreadStatus';

type Props = {
  threadId: string;
  pinned: boolean;
  hovered: boolean;
  onTogglePin: (e: MouseEvent) => void;
  togglePinAriaLabel: string;
  togglePinTestId: string;
};

export function ThreadStatusBadge(props: Props) {
  const isCurrent = useThreadsStore((s) => s.currentThreadId === props.threadId);
  const runStatus = useRunsStore((s) => s.runStateByThread[props.threadId]?.status ?? 'idle');
  const hasUnread = useUnreadStore((s) => !!s.unreadByThread[props.threadId]);

  const slot = pickSlot({
    hovered: props.hovered,
    pinned: props.pinned,
    isCurrent,
    runStatus,
    hasUnread,
  });

  if (slot === 'spinner') {
    return (
      <span
        className="w-4 h-4 inline-flex items-center justify-center shrink-0"
        data-testid={`thread-status-running-${props.threadId}`}
        aria-label="运行中"
      >
        <svg
          className="animate-spin"
          width={11}
          height={11}
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={3}
        >
          <circle cx={12} cy={12} r={10} opacity={0.25} />
          <path d="M22 12a10 10 0 0 1-10 10" strokeLinecap="round" />
        </svg>
      </span>
    );
  }

  if (slot === 'unreadDot') {
    return (
      <span
        className="w-4 h-4 inline-flex items-center justify-center shrink-0"
        data-testid={`thread-status-unread-${props.threadId}`}
        aria-label="有未读"
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--color-accent)',
          }}
        />
      </span>
    );
  }

  if (slot === 'pinButton') {
    return (
      <span
        className="w-4 h-4 inline-flex items-center justify-center shrink-0"
        style={{ color: 'var(--color-ink-faint)' }}
      >
        <button
          type="button"
          data-testid={props.togglePinTestId}
          aria-label={props.togglePinAriaLabel}
          onClick={props.onTogglePin}
          className="inline-flex items-center justify-center w-4 h-4 rounded"
          style={{
            color: props.pinned ? 'var(--color-ink-soft)' : 'var(--color-ink-faint)',
            cursor: 'pointer',
          }}
        >
          <NavIcon name="pin" size={12} />
        </button>
      </span>
    );
  }

  if (slot === 'pinIcon') {
    return (
      <span
        className="w-4 h-4 inline-flex items-center justify-center shrink-0"
        style={{ color: 'var(--color-ink-soft)' }}
        aria-label="已置顶"
      >
        <NavIcon name="pin" size={12} />
      </span>
    );
  }

  return <span className="w-4 h-4 inline-flex items-center justify-center shrink-0" />;
}
