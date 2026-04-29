import { useState, type MouseEvent } from 'react';
import { NavIcon } from '../../shared';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import type { Thread } from '../../../shared/types';

type Props = {
  thread: Thread;
};

export function ThreadRow({ thread }: Props) {
  const [hover, setHover] = useState(false);
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const select = useThreadsStore((s) => s.selectThread);
  const remove = useThreadsStore((s) => s.removeThread);
  const setThread = useThreadsStore((s) => s.setThread);
  const showThreadTab = useUiStore((s) => s.showThreadTab);

  const isSelected = currentThreadId === thread.id;
  const showLeftPin = !!thread.pinned || hover;

  const onPick = () => {
    showThreadTab();
    select(thread.id);
  };

  const onTogglePin = async (e: MouseEvent) => {
    e.stopPropagation();
    const next = !thread.pinned;
    setThread({ ...thread, pinned: next });
    try {
      const updated = await window.kydog.invoke('thread.update', { threadId: thread.id, pinned: next });
      setThread(updated);
    } catch (err) {
      setThread(thread);
      console.error('toggle thread pin failed', err);
    }
  };

  const onDelete = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await window.kydog.invoke('thread.delete', { threadId: thread.id });
      remove(thread.id);
    } catch (err) { console.error('delete thread failed', err); }
  };

  return (
    <div
      data-testid={`thread-${thread.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onPick}
      className="group flex items-center cursor-pointer rounded px-2.5 py-1 transition-colors hover:bg-[color:var(--color-hover-bg)]"
      style={{
        background: isSelected ? 'var(--color-paper-edge)' : undefined,
        color: 'var(--color-ink)',
        fontSize: 13,
        fontWeight: isSelected ? 500 : 400,
        gap: 8,
      }}
    >
      <span
        className="w-4 h-4 inline-flex items-center justify-center shrink-0"
        style={{ color: 'var(--color-ink-faint)' }}
      >
        {showLeftPin ? (
          <button
            type="button"
            data-testid={`pin-thread-${thread.id}`}
            aria-label={thread.pinned ? '取消置顶' : '置顶'}
            onClick={onTogglePin}
            className="inline-flex items-center justify-center w-4 h-4 rounded"
            style={{ color: thread.pinned ? 'var(--color-ink-soft)' : 'var(--color-ink-faint)', cursor: 'pointer' }}
          >
            <NavIcon name="pin" size={12} />
          </button>
        ) : null}
      </span>
      <span className="flex-1 truncate">{thread.title}</span>
      <button
        type="button"
        data-testid={`delete-thread-${thread.id}`}
        onClick={onDelete}
        aria-label="删除对话"
        className="inline-flex items-center justify-center shrink-0 transition-opacity"
        style={{
          width: 18, height: 18, borderRadius: 4,
          opacity: hover ? 1 : 0,
          pointerEvents: hover ? 'auto' : 'none',
          color: 'var(--color-ink-faint)',
        }}
      >
        <NavIcon name="x" size={12} />
      </button>
    </div>
  );
}
