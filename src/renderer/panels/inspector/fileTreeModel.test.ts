import { describe, it, expect } from 'vitest';
import type { FsNode } from '../../../shared/types';
import { sortFileNodes } from './fileTreeModel';

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
