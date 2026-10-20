import { useEffect, useState, type MouseEvent } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { MarqueeText, NavIcon, type NavIconName } from '../../shared';
import type { FsNode } from '../../../shared/types';
import { isHtmlPath, isMarkdownPath, isPdfPath } from '../main-pane/markdown/fileTabHelpers';
import { loadDir } from '../../fsWatch';

type RowProps = { node: FsNode; depth: number; selected: boolean; onSelect: (e: MouseEvent) => void; onContextMenu: (e: MouseEvent) => void };

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

export function FileTreeRow({ node, depth, selected, onSelect, onContextMenu }: RowProps) {
  const [hover, setHover] = useState(false);
  const expanded = useUiStore((s) => s.expandedDirs.has(node.path));
  const cache = useUiStore((s) => s.dirCache[node.path]);
  const pending = useUiStore((s) => s.dirPending.has(node.path));
  const error = useUiStore((s) => s.dirErrors[node.path]);
  const toggleDir = useUiStore((s) => s.toggleDir);
  const openFile = useUiStore((s) => s.openFile);

  useEffect(() => {
    // 失败后不自动重试：cache 仍是 undefined，不挡一下这个 effect 会跟着每次重渲染再读一遍。
    if (node.kind !== 'dir' || !expanded || cache || pending || error !== undefined) return;
    void loadDir(node.path);
  }, [expanded, cache, pending, error, node]);

  const isDir = node.kind === 'dir';
  const readme = !isDir && isReadme(node.name);
  const iconName = iconForNode(node, expanded);

  return (
    <div style={{ position: 'relative', paddingLeft: depth * 14 }}>
      {Array.from({ length: depth }, (_, i) => <div key={i} style={{ position: 'absolute', left: i * 14 + 6, top: 0, bottom: 0, width: 1, background: 'var(--color-ink-hair)' }} />)}
      <div
        data-testid={`fs-${node.path}`}
        data-file-path={node.path}
        aria-selected={selected}
        onContextMenu={onContextMenu}
        onMouseDown={e => { if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault(); }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={(e) => {
          e.stopPropagation();
          e.currentTarget.closest<HTMLElement>('[data-testid="file-tree"]')?.focus();
          if (e.shiftKey || e.ctrlKey || e.metaKey) e.preventDefault();
          if (isDir) toggleDir(node.path); else onSelect(e);
        }}
        onDoubleClick={() => {
          if (isDir) return;
          if (isMarkdownPath(node.path) || isPdfPath(node.path) || isHtmlPath(node.path)) openFile(node.path);
        }}
        className="flex items-center cursor-pointer hover:bg-[color:var(--color-hover-bg)]"
        style={{
          padding: '3px 8px 3px 0',
          borderRadius: 3,
          background: selected ? 'var(--color-hover-bg)' : undefined,
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
        {/* 与左栏 ThreadRow 同一套：hover 时整名匀速左移，不 hover 时省略号。 */}
        <div
          className="flex-1 min-w-0"
          style={readme ? { color: 'var(--color-accent)' } : undefined}
        >
          <MarqueeText
            text={node.name}
            active={hover}
            scrollTestId={`fs-name-scroll-${node.path}`}
          />
        </div>
      </div>
    </div>
  );
}
