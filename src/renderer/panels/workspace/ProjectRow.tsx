import { useEffect, useRef, useState, type Ref } from 'react';
import { NavIcon, IconButton, DropdownMenu, DropdownItem, DropdownDivider, isWindowBlur } from '../../shared';
import { useThreadsStore } from '../../stores/threadsStore';
import { useUiStore } from '../../stores/uiStore';
import { useUnreadStore } from './unreadStore';
import { confirm } from '../../stores/confirmStore';
import type { Project } from '../../../shared/types';

type Props = {
  project: Project;
  expanded: boolean;
  onToggleExpand: () => void;
};

export function ProjectRow({ project, expanded, onToggleExpand }: Props) {
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const baseName = project.label ?? project.path.split(/[\\/]/).pop() ?? project.path;
  const [draft, setDraft] = useState(baseName);
  const inputRef = useRef<HTMLInputElement>(null);
  const setProject = useThreadsStore((s) => s.setProject);
  const removeProject = useThreadsStore((s) => s.removeProject);
  const showThreadTab = useUiStore((s) => s.showThreadTab);
  const upsertThread = useThreadsStore((s) => s.upsertThread);
  const selectThread = useThreadsStore((s) => s.selectThread);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
      setDraft(baseName);
    }
  }, [renaming, baseName]);

  const onNewThread = async () => {
    try {
      const t = await window.kydog.invoke('thread.create', { projectPath: project.path });
      upsertThread(t);
      showThreadTab();
      selectThread(t.id);
      useUnreadStore.getState().markRead(t.id);
    } catch (err) { console.error('new thread failed', err); }
  };

  const onOpenFinder = () => {
    void window.kydog.invoke('project.openInOS', { projectPath: project.path }).catch((err) => console.error(err));
  };

  const onTogglePin = async () => {
    const next = !project.pinned;
    setProject({ ...project, pinned: next });
    try {
      const updated = await window.kydog.invoke('project.update', { projectPath: project.path, pinned: next });
      setProject(updated);
    } catch (err) {
      setProject(project);
      console.error('toggle pin failed', err);
    }
  };

  const commitRename = async () => {
    const trimmed = draft.trim();
    if (!renaming) return;
    setRenaming(false);
    if (!trimmed || trimmed === baseName) return;
    try {
      const updated = await window.kydog.invoke('project.update', { projectPath: project.path, label: trimmed });
      setProject(updated);
    } catch (err) { console.error('rename failed', err); }
  };

  const onRemove = async () => {
    const ok = await confirm({
      title: `从侧边栏移除「${baseName}」？`,
      message: '文件夹本身不会被删除。',
      confirmLabel: '移除',
    });
    if (!ok) return;
    try {
      await window.kydog.invoke('project.close', { projectPath: project.path });
      removeProject(project.path);
    } catch (err) { console.error('remove failed', err); }
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="group flex items-center w-full"
      style={{ padding: '2px 6px' }}
    >
      {renaming ? (
        <div
          className="flex items-center gap-2 flex-1 min-w-0 rounded px-2.5 py-1"
          style={{ background: 'var(--color-paper-edge)', fontSize: 13 }}
        >
          <span className="w-4 h-4 inline-flex items-center justify-center shrink-0" style={{ color: 'var(--color-ink-faint)' }}>
            <NavIcon name={expanded ? 'folder-open' : 'folder'} size={15} />
          </span>
          <input
            ref={inputRef}
            data-testid={`project-rename-input-${baseName}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); void commitRename(); }
              else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
            }}
            // 与 ThreadRow 同理：窗口整体失焦不算「编辑结束」
            onBlur={() => { if (isWindowBlur()) return; void commitRename(); }}
            className="flex-1 min-w-0 bg-transparent outline-none"
            style={{ fontSize: 13, color: 'var(--color-ink)' }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggleExpand}
          onDoubleClick={() => setRenaming(true)}
          data-testid={`project-toggle-${baseName}`}
          className="flex items-center gap-2 flex-1 min-w-0 text-left rounded px-2.5 py-1 transition-colors hover:bg-[color:var(--color-hover-bg)]"
          style={{ color: 'var(--color-ink-soft)', fontSize: 13 }}
        >
          <span className="w-4 h-4 inline-flex items-center justify-center shrink-0" style={{ color: 'var(--color-ink-faint)' }}>
            <NavIcon name={expanded ? 'folder-open' : 'folder'} size={15} />
          </span>
          <span className="flex-1 truncate">{baseName}</span>
          {project.pinned && (
            <span style={{ color: 'var(--color-ink-faint)' }} aria-label="已置顶">
              <NavIcon name="pin" size={11} />
            </span>
          )}
        </button>
      )}
      {!renaming && (
        <div
          className="flex items-center"
          style={{ opacity: hover ? 1 : 0, transition: 'opacity 100ms', pointerEvents: hover ? 'auto' : 'none' }}
        >
          <IconButton
            size={20}
            tone="faint"
            tooltip={`在「${baseName}」中开启新对话`}
            ariaLabel="新对话"
            testId={`project-new-thread-${baseName}`}
            onClick={onNewThread}
          >
            <NavIcon name="square-pen" size={13} />
          </IconButton>
          <DropdownMenu
            align="right"
            width={200}
            testId={`project-menu-${baseName}`}
            trigger={({ toggle, ref, open }) => (
              <IconButton
                ref={ref as Ref<HTMLButtonElement>}
                size={20}
                tone="faint"
                tooltip={open ? undefined : '更多操作'}
                ariaLabel="更多操作"
                active={open}
                testId={`project-menu-trigger-${baseName}`}
                onClick={toggle}
              >
                <NavIcon name="more-horizontal" size={13} />
              </IconButton>
            )}
          >
            <DropdownItem
              icon={<NavIcon name="pin" size={14} />}
              label={project.pinned ? '取消置顶' : '置顶项目'}
              testId={`project-pin-${baseName}`}
              onClick={() => void onTogglePin()}
            />
            <DropdownItem
              icon={<NavIcon name="folder-open" size={14} />}
              label='在"访达"中打开'
              testId={`project-open-finder-${baseName}`}
              onClick={onOpenFinder}
            />
            <DropdownItem
              icon={<NavIcon name="pencil-line" size={14} />}
              label="重命名项目"
              testId={`project-rename-${baseName}`}
              onClick={() => setRenaming(true)}
            />
            <DropdownDivider />
            <DropdownItem
              icon={<NavIcon name="x" size={14} />}
              label="移除"
              destructive
              testId={`project-remove-${baseName}`}
              onClick={() => void onRemove()}
            />
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}
