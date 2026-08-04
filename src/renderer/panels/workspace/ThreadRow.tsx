import { useEffect, useRef, useState, type MouseEvent, type Ref } from 'react';
import { NavIcon, IconButton, DropdownMenu, DropdownItem, MarqueeText, isWindowBlur } from '../../shared';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { confirm } from '../../stores/confirmStore';
import { useUnreadStore } from './unreadStore';
import { ThreadStatusBadge } from './ThreadStatusBadge';
import type { Thread } from '../../../shared/types';

type Props = {
  thread: Thread;
};

export function ThreadRow({ thread }: Props) {
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const select = useThreadsStore((s) => s.selectThread);
  const remove = useThreadsStore((s) => s.removeThread);
  const setThread = useThreadsStore((s) => s.setThread);
  const showThreadTab = useUiStore((s) => s.showThreadTab);

  const isSelected = currentThreadId === thread.id;

  // 只在进入重命名态时把 draft 重置为当前标题；不把 thread.title 放进依赖，
  // 避免编辑途中标题被并发更新（自动生成 / 跨窗口）冲掉用户正在输入的内容。
  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
      setDraft(thread.title);
    }
  }, [renaming]);

  const onPick = () => {
    showThreadTab();
    select(thread.id);
    useUnreadStore.getState().markRead(thread.id);
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

  const commitRename = async () => {
    if (!renaming) return;
    const t = draft.trim();
    setRenaming(false);
    if (!t || t === thread.title) return;
    setThread({ ...thread, title: t });
    try {
      const updated = await window.kydog.invoke('thread.update', { threadId: thread.id, title: t });
      setThread(updated);
    } catch (err) {
      setThread(thread);
      console.error('rename thread failed', err);
    }
  };

  const onDelete = async (e: MouseEvent) => {
    e.stopPropagation();
    const ok = await confirm({ title: `删除对话「${thread.title}」？`, confirmLabel: '删除' });
    if (!ok) return;
    try {
      await window.kydog.invoke('thread.delete', { threadId: thread.id });
      useUnreadStore.getState().clearOne(thread.id);
      remove(thread.id);
    } catch (err) { console.error('delete thread failed', err); }
  };

  return (
    <div
      data-testid={`thread-${thread.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={renaming ? undefined : onPick}
      className="group flex items-center cursor-pointer rounded px-2.5 py-1 transition-colors hover:bg-[color:var(--color-hover-bg)]"
      style={{
        background: isSelected ? 'var(--color-paper-edge)' : undefined,
        color: 'var(--color-ink)',
        fontSize: 13,
        fontWeight: isSelected ? 500 : 400,
        gap: 8,
      }}
    >
      <ThreadStatusBadge
        threadId={thread.id}
        pinned={!!thread.pinned}
        hovered={hover}
        onTogglePin={onTogglePin}
        togglePinAriaLabel={thread.pinned ? '取消置顶' : '置顶'}
        togglePinTestId={`pin-thread-${thread.id}`}
      />
      {renaming ? (
        <input
          ref={inputRef}
          data-testid={`thread-rename-input-${thread.id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
            else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
          }}
          // 窗口整体失焦不算「编辑结束」—— 否则切到别的应用再切回来，
          // 正在编辑的重命名框已经没了（见 isWindowBlur 的说明）。
          onBlur={() => { if (isWindowBlur()) return; void commitRename(); }}
          className="flex-1 min-w-0 bg-transparent outline-none"
          style={{ fontSize: 13, color: 'var(--color-ink)' }}
        />
      ) : (
        <>
          <MarqueeText
            className="flex-1 min-w-0"
            text={thread.title}
            active={hover}
            scrollTestId={`thread-title-scroll-${thread.id}`}
          />
          <div
            className="flex items-center"
            onClick={(e) => e.stopPropagation()}
            style={{ opacity: hover ? 1 : 0, transition: 'opacity 100ms', pointerEvents: hover ? 'auto' : 'none' }}
          >
            <DropdownMenu
              align="right"
              width={160}
              testId={`thread-menu-${thread.id}`}
              trigger={({ toggle, ref, open }) => (
                <IconButton
                  ref={ref as Ref<HTMLButtonElement>}
                  size={18}
                  tone="faint"
                  tooltip={open ? undefined : '更多操作'}
                  ariaLabel="更多操作"
                  active={open}
                  testId={`thread-menu-trigger-${thread.id}`}
                  onClick={toggle}
                >
                  <NavIcon name="more-horizontal" size={13} />
                </IconButton>
              )}
            >
              <DropdownItem
                icon={<NavIcon name="pencil-line" size={14} />}
                label="重命名"
                testId={`thread-rename-${thread.id}`}
                onClick={() => setRenaming(true)}
              />
            </DropdownMenu>
            <button
              type="button"
              data-testid={`delete-thread-${thread.id}`}
              onClick={onDelete}
              aria-label="删除对话"
              className="inline-flex items-center justify-center shrink-0"
              style={{ width: 18, height: 18, borderRadius: 4, color: 'var(--color-ink-faint)' }}
            >
              <NavIcon name="x" size={12} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
