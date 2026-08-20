import { useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { NavIcon, type NavIconName } from '../../shared';
import type { FsNode } from '../../../shared/types';
import { isHtmlPath, isMarkdownPath, isPdfPath } from '../main-pane/markdown/fileTabHelpers';

type RowProps = { node: FsNode };

const isReadme = (name: string) => /^readme(\..+)?$/i.test(name);
const CODE_EXTENSIONS = new Set([
  'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'ini', 'java', 'js', 'jsx', 'kt',
  'mjs', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svg', 'svelte', 'toml', 'tsx', 'ts', 'vue',
  'yaml', 'yml', 'zsh', 'json', 'jsonl', 'lock',
]);
const SHEET_EXTENSIONS = new Set(['csv', 'tsv', 'xls', 'xlsx']);
const TEXT_EXTENSIONS = new Set(['log', 'md', 'mdx', 'pdf', 'rtf', 'txt']);

function iconForNode(node: FsNode, expanded: boolean): NavIconName {
  if (node.kind === 'dir') return expanded ? 'folder-open' : 'folder';
  if (isReadme(node.name)) return 'book-open-text';

  const ext = node.name.includes('.') ? node.name.split('.').pop()?.toLowerCase() ?? '' : '';
  if (SHEET_EXTENSIONS.has(ext)) return 'file-spreadsheet';
  if (CODE_EXTENSIONS.has(ext)) return 'file-diff';
  if (TEXT_EXTENSIONS.has(ext)) return 'file-text';
  return 'file-text';
}

function Row({ node }: RowProps) {
  const expanded = useUiStore((s) => s.expandedDirs.has(node.path));
  const cache = useUiStore((s) => s.dirCache[node.path]);
  const toggleDir = useUiStore((s) => s.toggleDir);
  const setDir = useUiStore((s) => s.setDir);
  const openFile = useUiStore((s) => s.openFile);

  useEffect(() => {
    if (node.kind !== 'dir' || !expanded || cache) return;
    void window.kydog.invoke('project.readDir', { path: node.path }).then((nodes) => setDir(node.path, nodes));
  }, [expanded, cache, node, setDir]);

  const isDir = node.kind === 'dir';
  const readme = !isDir && isReadme(node.name);
  const iconName = iconForNode(node, expanded);

  return (
    <div>
      <div
        data-testid={`fs-${node.path}`}
        onClick={() => isDir ? toggleDir(node.path) : null}
        onDoubleClick={() => {
          if (isDir) return;
          if (isMarkdownPath(node.path) || isPdfPath(node.path) || isHtmlPath(node.path)) openFile(node.path);
        }}
        className="flex items-center cursor-pointer hover:bg-[color:var(--color-hover-bg)]"
        style={{
          padding: '3px 8px 3px 0',
          borderRadius: 3,
          color: isDir ? 'var(--color-ink-soft)' : 'var(--color-ink)',
          fontFamily: 'var(--font-sans)', fontWeight: 400, fontSize: 12,
        }}
      >
        <span
          className="inline-flex items-center justify-center shrink-0"
          style={{ width: 16, color: 'var(--color-ink-faint)' }}
        >
          {isDir && (
            <NavIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
          )}
        </span>
        <span
          className="inline-flex items-center justify-center shrink-0"
          style={{ width: 16, color: readme ? 'var(--color-accent)' : 'var(--color-ink-soft)' }}
        >
          <NavIcon name={iconName} size={14} />
        </span>
        <span
          className="flex-1 truncate"
          style={readme ? { color: 'var(--color-accent)' } : undefined}
        >
          {node.name}
        </span>
      </div>
      {isDir && expanded && cache && (
        <div style={{ position: 'relative', paddingLeft: 14 }}>
          <div
            style={{
              position: 'absolute', left: 6, top: 0, bottom: 0,
              width: 1, background: 'var(--color-ink-hair)',
            }}
          />
          {cache.map((child) => <Row key={child.path} node={child} />)}
        </div>
      )}
    </div>
  );
}

export function FileTree({ projectPath }: { projectPath: string }) {
  const cache = useUiStore((s) => s.dirCache[projectPath]);
  const setDir = useUiStore((s) => s.setDir);

  useEffect(() => {
    if (cache) return;
    void window.kydog.invoke('project.readDir', { path: projectPath }).then((nodes) => setDir(projectPath, nodes));
  }, [projectPath, cache, setDir]);

  if (!cache) {
    return <div className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--color-ink-soft)' }}>加载中…</div>;
  }
  return (
    <div className="ky-scroll overflow-auto h-full" data-testid="file-tree" style={{ padding: '0 8px' }}>
      {cache.map((n) => <Row key={n.path} node={n} />)}
    </div>
  );
}
