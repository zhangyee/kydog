import { useEffect, useState } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { MarqueeText, NavIcon, type NavIconName } from '../../shared';
import type { FsNode } from '../../../shared/types';
import { isHtmlPath, isMarkdownPath, isPdfPath } from '../main-pane/markdown/fileTabHelpers';
import { ErrorMarginalia } from '../main-pane/ErrorMarginalia';
import { loadDir } from '../../fsWatch';

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

/** 读目录失败时说出来。与 ThreadView 同一个形态：错误原文 + 重试，重试只是清掉错误，
 *  让读目录的那个 effect 自己再跑一次。 */
function DirError({ message, onRetry, testId }: { message: string; onRetry: () => void; testId: string }) {
  return (
    <div data-testid={testId} style={{ padding: '2px 8px 6px' }}>
      <ErrorMarginalia text={`无法读取：${message}`} />
      <button
        type="button"
        data-testid={`${testId}-retry`}
        onClick={onRetry}
        className="font-sans"
        style={{ fontSize: 12, color: 'var(--color-ink-soft)', textDecoration: 'underline' }}
      >
        重试
      </button>
    </div>
  );
}

function Row({ node }: RowProps) {
  const [hover, setHover] = useState(false);
  const expanded = useUiStore((s) => s.expandedDirs.has(node.path));
  const cache = useUiStore((s) => s.dirCache[node.path]);
  const pending = useUiStore((s) => s.dirPending.has(node.path));
  const error = useUiStore((s) => s.dirErrors[node.path]);
  const toggleDir = useUiStore((s) => s.toggleDir);
  const retryDir = useUiStore((s) => s.retryDir);
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
    <div>
      <div
        data-testid={`fs-${node.path}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
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
      {isDir && expanded && error !== undefined && (
        <div style={{ paddingLeft: 14 }}>
          <DirError message={error} onRetry={() => retryDir(node.path)} testId={`fs-error-${node.path}`} />
        </div>
      )}
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
  const pending = useUiStore((s) => s.dirPending.has(projectPath));
  const error = useUiStore((s) => s.dirErrors[projectPath]);
  const retryDir = useUiStore((s) => s.retryDir);

  useEffect(() => {
    // 同 Row：失败后停下，等用户点重试。
    if (cache || pending || error !== undefined) return;
    void loadDir(projectPath);
  }, [projectPath, cache, pending, error]);

  if (error !== undefined) {
    return <DirError message={error} onRetry={() => retryDir(projectPath)} testId="file-tree-error" />;
  }
  if (!cache) {
    return <div className="px-3 py-2 font-mono text-xs" style={{ color: 'var(--color-ink-soft)' }}>加载中…</div>;
  }
  return (
    <div className="ky-scroll overflow-auto h-full" data-testid="file-tree" style={{ padding: '0 8px' }}>
      {cache.map((n) => <Row key={n.path} node={n} />)}
    </div>
  );
}
