import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { loadDir } from '../../fsWatch';
import { isTrashablePath, type TrashFilesResult } from '../../../shared/files';
import { ContextMenu } from '../../shared/ContextMenu';
import { DropdownItem, DropdownSection } from '../../shared/DropdownMenu';
import { NavIcon } from '../../shared';
import { ErrorMarginalia } from '../main-pane/ErrorMarginalia';
import { FileTreeRow } from './FileTreeRow';
import { FileTreeError } from './FileTreeError';
import { FileTreeToolbar } from './FileTreeToolbar';
import { visibleFileRows } from './fileTreeModel';
import { effectiveFileSelection, isFileSelectionToggle, selectFile, type FileSelection } from './fileTreeSelection';
import { deleteProjectFiles } from './fileActions';

const EMPTY_SELECTION: FileSelection = { selectedPaths: [], anchorPath: null };

/** Selection and action state belong to this keyed project instance; sort belongs to the window. */
export function FileTree({ projectPath }: { projectPath: string }) {
  const cache = useUiStore(s => s.dirCache);
  const expanded = useUiStore(s => s.expandedDirs);
  const loading = useUiStore(s => s.dirPending.has(projectPath));
  const dirErrors = useUiStore(s => s.dirErrors);
  const retryDir = useUiStore(s => s.retryDir);
  const sortBy = useUiStore(s => s.fileTreeSortBy);
  const onSort = useUiStore(s => s.setFileTreeSortBy);
  const [selection, setSelection] = useState<FileSelection>(EMPTY_SELECTION);
  const [pending, setPending] = useState(false);
  const [failures, setFailures] = useState<TrashFilesResult['failed']>([]);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const rows = useMemo(() => visibleFileRows(projectPath, cache, expanded, sortBy), [projectPath, cache, expanded, sortBy]);
  const order = useMemo(() => rows.filter(r => r.node.kind === 'file' && isTrashablePath(r.node.path)).map(r => r.node.path), [rows]);
  const selected = effectiveFileSelection(selection, order);

  useEffect(() => {
    // A disappearing context target must not turn its batch menu into another file's single action.
    setMenu(current => current !== null && !order.includes(current.path) ? null : current);
    setSelection(s => {
      const selectedPaths = s.selectedPaths.filter(path => order.includes(path));
      const anchorPath = s.anchorPath !== null && order.includes(s.anchorPath) ? s.anchorPath : null;
      return selectedPaths.length === s.selectedPaths.length && anchorPath === s.anchorPath ? s : { selectedPaths, anchorPath };
    });
  }, [order]);
  useEffect(() => {
    if (cache[projectPath] || loading || dirErrors[projectPath] !== undefined) return;
    void loadDir(projectPath);
  }, [projectPath, cache, loading, dirErrors]);

  const remove = async () => {
    if (lock.current || !selected.length) return;
    // Acquire synchronously, before opening confirm: a second click must not replace its resolver.
    lock.current = true;
    setPending(true);
    setMenu(null);
    setError(null);
    setFailures([]);
    const targets = rows.filter(r => selected.includes(r.node.path)).map(r => ({ path: r.node.path, parentPath: r.parentPath }));
    try {
      const result = await deleteProjectFiles(projectPath, targets);
      if (!alive.current || result === null) return;
      setSelection(s => ({ selectedPaths: s.selectedPaths.filter(path => !result.trashed.includes(path)), anchorPath: s.anchorPath !== null && result.trashed.includes(s.anchorPath) ? null : s.anchorPath }));
      setFailures(result.failed);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      lock.current = false;
      if (alive.current) setPending(false);
    }
  };
  const context = (path: string, e: MouseEvent) => {
    if (!order.includes(path)) return;
    e.preventDefault(); e.stopPropagation();
    if (!selected.includes(path)) setSelection({ selectedPaths: [path], anchorPath: path });
    setMenu({ x: e.clientX, y: e.clientY, path });
  };

  if (dirErrors[projectPath] !== undefined) return <FileTreeError message={dirErrors[projectPath]} onRetry={() => retryDir(projectPath)} testId="file-tree-error" />;
  if (!cache[projectPath]) return <div className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--color-ink-soft)' }}>加载中…</div>;
  return <div className="h-full flex flex-col" style={{ padding: '0 8px' }}>
    <FileTreeToolbar sortBy={sortBy} onSort={onSort} />
    {/* Keep the local keyboard target; its UA :focus-visible outline spans the whole list after Shift-click.
        Only this container suppresses that outline; check/menu buttons retain their native focus cues. */}
    <div data-testid="file-tree" tabIndex={0} style={{ outline: 'none' }} className="ky-scroll overflow-auto flex-1" onClick={() => { setSelection(EMPTY_SELECTION); setMenu(null); }}
      onKeyDown={e => {
        const target = e.target as HTMLElement;
        if (e.defaultPrevented || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return;
        if (e.key === 'Escape') { setSelection(EMPTY_SELECTION); setMenu(null); }
        if (e.key === 'Delete' && selected.length) { e.preventDefault(); void remove(); }
      }}>
      {error !== null && <ErrorMarginalia text={`删除失败：${error}`} />}
      {failures.map(f => <ErrorMarginalia key={f.path} text={`${f.path.split(/[\\/]/).pop()}：${f.error.message}`} />)}
      {rows.map(({ node, depth }) => <Fragment key={node.path}>
        <FileTreeRow
          node={node}
          depth={depth}
          selected={selected.includes(node.path)}
          multi={selected.length >= 2}
          onSelect={e => setSelection(s => selectFile(s, { path: node.path, shift: e.shiftKey, toggle: isFileSelectionToggle(e, window.kydog.platform) }, order))}
          onPick={() => setSelection(s => selectFile(s, { path: node.path, shift: false, toggle: false }, order))}
          onContextMenu={e => context(node.path, e)}
        />
        {node.kind === 'dir' && expanded.has(node.path) && dirErrors[node.path] !== undefined && <div style={{ paddingLeft: (depth + 1) * 14 }}><FileTreeError message={dirErrors[node.path]} onRetry={() => retryDir(node.path)} testId={`fs-error-${node.path}`} /></div>}
      </Fragment>)}
      {menu && selected.includes(menu.path) && (
        <ContextMenu at={menu} width={selected.length >= 2 ? 220 : 168} testId="file-context-menu" onClose={() => setMenu(null)}>
          {selected.length >= 2 ? (
            <DropdownSection title={`已选 ${selected.length} 个文件`}>
              <DropdownItem
                icon={<NavIcon name="trash-2" size={14} />}
                label={`删除 ${selected.length} 个文件…`}
                destructive
                testId="file-ctx-batch-delete"
                disabled={pending}
                onClick={() => void remove()}
              />
            </DropdownSection>
          ) : (
            <DropdownItem
              icon={<NavIcon name="trash-2" size={14} />}
              label="删除…"
              destructive
              testId={`file-ctx-delete-${menu.path}`}
              disabled={pending || selected.length === 0}
              onClick={() => void remove()}
            />
          )}
        </ContextMenu>
      )}
    </div>
  </div>;
}
