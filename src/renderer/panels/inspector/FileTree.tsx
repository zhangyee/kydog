import { useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';
import type { FsNode } from '../../../shared/types';

function Node({ node, depth }: { node: FsNode; depth: number }) {
  const expanded = useUiStore((s) => s.expandedDirs.has(node.path));
  const cache = useUiStore((s) => s.dirCache[node.path]);
  const toggleDir = useUiStore((s) => s.toggleDir);
  const setDir = useUiStore((s) => s.setDir);

  useEffect(() => {
    if (node.kind !== 'dir' || !expanded || cache) return;
    void window.kydog.invoke('project.readDir', { path: node.path }).then((nodes) => setDir(node.path, nodes));
  }, [expanded, cache, node, setDir]);

  return (
    <div>
      <div
        data-testid={`fs-${node.path}`}
        className="cursor-pointer truncate hover:bg-[color:var(--color-paper-edge)]/30 px-1 text-sm font-sans"
        style={{ paddingLeft: depth * 12 + 4 }}
        onClick={() => node.kind === 'dir' && toggleDir(node.path)}
        onDoubleClick={() => node.kind === 'file' && console.log('open file (Phase G):', node.path)}
      >
        {node.kind === 'dir' ? (expanded ? '▾' : '▸') : ' '} {node.name}
      </div>
      {node.kind === 'dir' && expanded && cache && (
        <div className="border-l border-[color:var(--color-paper-edge)] ml-3">
          {cache.map((child) => <Node key={child.path} node={child} depth={depth + 1} />)}
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

  if (!cache) return <div className="px-3 py-2 text-xs font-mono text-[color:var(--color-ink-soft)]">加载中…</div>;
  return (
    <div className="overflow-auto" data-testid="file-tree">
      {cache.map((n) => <Node key={n.path} node={n} depth={0} />)}
    </div>
  );
}
