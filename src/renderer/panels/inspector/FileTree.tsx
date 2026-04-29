import { useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { NavIcon } from '../../shared';
import type { FsNode } from '../../../shared/types';

type RowProps = { node: FsNode; depth: number; ancestorsLast: boolean[]; last?: boolean };

const isReadme = (name: string) => /^readme(\..+)?$/i.test(name);

function Row({ node, depth, ancestorsLast, last }: RowProps) {
  const expanded = useUiStore((s) => s.expandedDirs.has(node.path));
  const cache = useUiStore((s) => s.dirCache[node.path]);
  const toggleDir = useUiStore((s) => s.toggleDir);
  const setDir = useUiStore((s) => s.setDir);

  useEffect(() => {
    if (node.kind !== 'dir' || !expanded || cache) return;
    void window.kydog.invoke('project.readDir', { path: node.path }).then((nodes) => setDir(node.path, nodes));
  }, [expanded, cache, node, setDir]);

  const isDir = node.kind === 'dir';
  const readme = !isDir && isReadme(node.name);

  return (
    <div>
      <div
        data-testid={`fs-${node.path}`}
        onClick={() => isDir ? toggleDir(node.path) : null}
        onDoubleClick={() => !isDir && console.info('open file (D subsystem):', node.path)}
        className="flex items-center cursor-pointer hover:bg-[color:var(--color-paper-edge)]"
        style={{
          padding: '3px 8px 3px 0', borderRadius: 3, marginLeft: 4,
          color: isDir ? 'var(--color-ink-soft)' : 'var(--color-ink)',
          fontFamily: 'var(--font-sans)', fontWeight: 400, fontSize: 12, position: 'relative',
        }}
      >
        {Array.from({ length: depth }).map((_, i) => {
          const isLastCol = i === depth - 1;
          const ancestorTerminated = ancestorsLast[i];
          return (
            <span key={i} className="self-stretch shrink-0 relative" style={{ width: 14 }}>
              {!ancestorTerminated && (
                <span
                  style={{
                    position: 'absolute', left: 6, top: 0,
                    bottom: isLastCol && last ? '50%' : 0,
                    width: 1, background: 'var(--color-ink-hair)',
                  }}
                />
              )}
            </span>
          );
        })}
        <span
          className="shrink-0 flex items-center justify-center"
          style={{ width: 16, color: 'var(--color-ink-faint)' }}
        >
          {isDir && <NavIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />}
        </span>
        <span
          className="flex-1 truncate"
          style={readme ? { color: 'var(--color-accent)' } : undefined}
        >
          {node.name}
        </span>
      </div>
      {isDir && expanded && cache && (
        <div>
          {cache.map((child, i) => (
            <Row
              key={child.path}
              node={child}
              depth={depth + 1}
              ancestorsLast={[...ancestorsLast, !!last]}
              last={i === cache.length - 1}
            />
          ))}
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
      {cache.map((n, i) => (
        <Row
          key={n.path}
          node={n}
          depth={0}
          ancestorsLast={[]}
          last={i === cache.length - 1}
        />
      ))}
    </div>
  );
}
