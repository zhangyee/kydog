import { useCallback, useEffect, useRef, useState, type MouseEvent, type Ref } from 'react';
import { NavIcon, IconButton, DropdownMenu, DropdownItem, DropdownSection, DropdownDivider, ContextMenu, MarqueeText, Tooltip, isWindowBlur } from '../../shared';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { useRunsStore } from '../../stores/runsStore';
import { useUnreadStore } from './unreadStore';
import { useSidebarSelection } from './sidebarSelection';
import { archiveThreads, deleteThreads, threadsByIds } from './threadActions';
import { ThreadStatusBadge } from './ThreadStatusBadge';
import type { Thread } from '../../../shared/types';

type Props = {
  thread: Thread;
  /** 当前多选（effectiveSelection 的结果，按可见顺序）；空 = 没有多选。 */
  selection: string[];
  /** 左栏的可见顺序，⇧ 区间按它算。 */
  order: string[];
};

const RUNNING_HINT = '运行中，停止后才能归档';

export function ThreadRow({ thread, selection, order }: Props) {
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const currentThreadId = useThreadsStore((s) => s.currentThreadId);
  const select = useThreadsStore((s) => s.selectThread);
  const setThread = useThreadsStore((s) => s.setThread);
  const showThreadTab = useUiStore((s) => s.showThreadTab);
  const runStateByThread = useRunsStore((s) => s.runStateByThread);

  const isCurrent = currentThreadId === thread.id;
  const multi = selection.length >= 2;
  const selected = multi && selection.includes(thread.id);
  const running = runStateByThread[thread.id]?.status === 'running';
  const showActions = hover && !multi;

  // 只在进入重命名态时把 draft 重置为当前标题；不把 thread.title 放进依赖，
  // 避免编辑途中标题被并发更新（自动生成 / 跨窗口）冲掉用户正在输入的内容。
  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
      setDraft(thread.title);
    }
  }, [renaming]);

  /** 切换键：macOS 是 ⌘，Windows / Linux 是 Ctrl（macOS 上 Ctrl+单击本来就是右键，走 contextmenu）。 */
  const isToggle = (e: MouseEvent) => (window.kydog.platform === 'darwin' ? e.metaKey : e.ctrlKey);

  const onPick = () => {
    showThreadTab();
    select(thread.id);
    useUnreadStore.getState().markRead(thread.id);
  };

  const onRowMouseDown = (e: MouseEvent) => {
    // 不拦的话 Chromium 会把两行之间的标题文字选成一片蓝。
    if (e.shiftKey || isToggle(e)) e.preventDefault();
  };

  const onRowClick = (e: MouseEvent) => {
    const shift = e.shiftKey;
    const toggle = isToggle(e);
    useSidebarSelection.getState().click(
      { id: thread.id, shift, toggle },
      { order, currentId: useThreadsStore.getState().currentThreadId },
    );
    if (shift || toggle) return;
    onPick();
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    // 右键点在没被选中的行上：多选清空，只对这一行弹菜单；不打开它。
    if (!selected) useSidebarSelection.getState().clear();
    setMenuAt({ x: e.clientX, y: e.clientY });
  };

  // ContextMenu 的 window 监听 effect 依赖 onClose：内联箭头函数每次渲染都是新引用，
  // 会导致那三个 window 监听每次重渲染都拆了重挂。这里给一个稳定引用。
  const closeMenu = useCallback(() => setMenuAt(null), []);

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

  const onArchiveOne = () => { void archiveThreads([thread]); };
  const onDeleteOne = () => { void deleteThreads([thread]); };

  const onBatchArchive = () => {
    const targets = threadsByIds(selection);
    useSidebarSelection.getState().clear();
    void archiveThreads(targets);
  };
  const onBatchDelete = async () => {
    // 取消的话多选留着，用户可以接着改主意。
    if (await deleteThreads(threadsByIds(selection))) useSidebarSelection.getState().clear();
  };

  /** 「…」菜单与右键单行菜单是同一份（spec §2.1），testId 前缀区分两处。 */
  const singleItems = (prefix: 'thread' | 'thread-ctx') => (
    <>
      <DropdownItem
        icon={<NavIcon name="pencil-line" size={14} />}
        label="重命名"
        testId={`${prefix}-rename-${thread.id}`}
        onClick={() => setRenaming(true)}
      />
      <DropdownItem
        icon={<NavIcon name="archive" size={14} />}
        label="归档"
        disabled={running}
        hint={running ? '运行中' : undefined}
        testId={`${prefix}-archive-${thread.id}`}
        onClick={onArchiveOne}
      />
      <DropdownDivider />
      <DropdownItem
        icon={<NavIcon name="trash-2" size={14} />}
        label="删除…"
        destructive
        testId={`${prefix}-delete-${thread.id}`}
        onClick={onDeleteOne}
      />
    </>
  );

  const runningInSelection = selected
    ? selection.filter((id) => runStateByThread[id]?.status === 'running').length
    : 0;

  const archiveButton = (
    <IconButton
      size={18}
      tone="faint"
      tooltip="归档"
      ariaLabel="归档"
      disabled={running}
      testId={`archive-thread-${thread.id}`}
      onClick={onArchiveOne}
    >
      <NavIcon name="archive" size={12} />
    </IconButton>
  );

  return (
    <div
      data-testid={`thread-${thread.id}`}
      data-selected={selected ? 'true' : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseDown={renaming ? undefined : onRowMouseDown}
      onClick={renaming ? undefined : onRowClick}
      onContextMenu={renaming ? undefined : onContextMenu}
      className="group flex items-center cursor-pointer rounded px-2.5 py-1 transition-colors hover:bg-[color:var(--color-hover-bg)]"
      style={{
        background: selected ? 'var(--color-accent-soft)' : isCurrent ? 'var(--color-paper-edge)' : undefined,
        color: 'var(--color-ink)',
        fontSize: 13,
        fontWeight: isCurrent ? 500 : 400,
        gap: 8,
      }}
    >
      <ThreadStatusBadge
        threadId={thread.id}
        pinned={!!thread.pinned}
        hovered={hover && !multi}
        selected={selected}
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
          {/* 多选态下不出悬停按钮：避免「点的是这一行还是这一批」的歧义，右键是批量的唯一入口。 */}
          <div
            data-testid="thread-row-actions"
            className="flex items-center"
            onClick={(e) => e.stopPropagation()}
            style={{ opacity: showActions ? 1 : 0, transition: 'opacity 100ms', pointerEvents: showActions ? 'auto' : 'none' }}
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
              {singleItems('thread')}
            </DropdownMenu>
            {running ? <Tooltip content={RUNNING_HINT}>{archiveButton}</Tooltip> : archiveButton}
          </div>
        </>
      )}
      {menuAt && (
        <ContextMenu
          at={menuAt}
          width={selected ? 220 : 168}
          testId={`thread-context-menu-${thread.id}`}
          onClose={closeMenu}
        >
          {selected ? (
            <DropdownSection title={`已选 ${selection.length} 个对话`}>
              <DropdownItem
                icon={<NavIcon name="archive" size={14} />}
                label={`归档 ${selection.length} 个对话`}
                disabled={runningInSelection > 0}
                hint={runningInSelection > 0 ? `其中 ${runningInSelection} 个正在运行` : undefined}
                testId="thread-ctx-batch-archive"
                onClick={onBatchArchive}
              />
              <DropdownItem
                icon={<NavIcon name="trash-2" size={14} />}
                label={`删除 ${selection.length} 个对话…`}
                destructive
                testId="thread-ctx-batch-delete"
                onClick={() => { void onBatchDelete(); }}
              />
            </DropdownSection>
          ) : singleItems('thread-ctx')}
        </ContextMenu>
      )}
    </div>
  );
}
