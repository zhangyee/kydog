import { describe, it, expect } from 'vitest';
import type { FsNode } from '../../../shared/types';
import { sortFileNodes, visibleFileRows } from './fileTreeModel';

describe('sortFileNodes', () => {
  it('目录始终名称升序；文件支持名称或真实时间降序，未知时间最后，同时间按名称', () => {
    const nodes: readonly FsNode[] = Object.freeze([
      { name: 'unknown.md', path: '/p/unknown.md', kind: 'file', mtimeMs: null },
      { name: 'dir-z', path: '/p/dir-z', kind: 'dir', mtimeMs: 100 },
      { name: 'b.pdf', path: '/p/b.pdf', kind: 'file', mtimeMs: 20 },
      { name: 'z.pdf', path: '/p/z.pdf', kind: 'file', mtimeMs: 30 },
      { name: 'dir-a', path: '/p/dir-a', kind: 'dir', mtimeMs: null },
      { name: 'a.md', path: '/p/a.md', kind: 'file', mtimeMs: 20 },
    ]);
    expect(sortFileNodes(nodes, 'name').map((n) => n.name)).toEqual(['dir-a', 'dir-z', 'a.md', 'b.pdf', 'unknown.md', 'z.pdf']);
    expect(sortFileNodes(nodes, 'modified').map((n) => n.name)).toEqual(['dir-a', 'dir-z', 'z.pdf', 'a.md', 'b.pdf', 'unknown.md']);
    expect(nodes.map((n) => n.name)).toEqual(['unknown.md', 'dir-z', 'b.pdf', 'z.pdf', 'dir-a', 'a.md']);
  });
});

it('visibleFileRows follows sorted DFS, captures parent paths and prunes collapsed children', () => {
  const dir: FsNode = { path: '/p/sub', name: 'sub', kind: 'dir', mtimeMs: 999 };
  const a: FsNode = { path: '/p/a.md', name: 'a.md', kind: 'file', mtimeMs: 10 };
  const z: FsNode = { path: '/p/z.pdf', name: 'z.pdf', kind: 'file', mtimeMs: 90 };
  const b: FsNode = { path: '/p/sub/b.html', name: 'b.html', kind: 'file', mtimeMs: 2 };
  const c: FsNode = { path: '/p/sub/c.md', name: 'c.md', kind: 'file', mtimeMs: 3 };
  const cache = { '/p': [a, z, dir], '/p/sub': [b, c] };
  expect(visibleFileRows('/p', cache, new Set(['/p/sub']), 'modified')).toEqual([
    { node: dir, parentPath: '/p', depth: 0 }, { node: c, parentPath: '/p/sub', depth: 1 },
    { node: b, parentPath: '/p/sub', depth: 1 }, { node: z, parentPath: '/p', depth: 0 }, { node: a, parentPath: '/p', depth: 0 },
  ]);
  expect(visibleFileRows('/p', cache, new Set(), 'name').map(r => r.node.path)).toEqual(['/p/sub', '/p/a.md', '/p/z.pdf']);
  expect(cache['/p']).toEqual([a, z, dir]);
});
