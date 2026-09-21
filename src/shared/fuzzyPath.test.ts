import { describe, it, expect } from 'vitest';
import { rankPaths } from './fuzzyPath';

describe('rankPaths', () => {
  it('分档：文件名开头 > 文件名连续包含 > 路径连续包含 > 文件名子序列 > 路径子序列；都不中的排除', () => {
    const paths = ['zzz.md', 'd/p/o.txt', 'data/d-p-o.csv', 'dpo/readme.md', 'notes/ipo-vs-dpo.pdf', 'refs/dpo-2023.pdf'];
    expect(rankPaths(paths, 'dpo')).toEqual([
      'refs/dpo-2023.pdf', 'notes/ipo-vs-dpo.pdf', 'dpo/readme.md', 'data/d-p-o.csv', 'd/p/o.txt',
    ]);
  });

  it('大小写不敏感；同档按路径长度、再按字典序', () => {
    expect(rankPaths(['b/DPO.md', 'a/dpo.md', 'dpo.md'], 'Dpo')).toEqual(['dpo.md', 'a/dpo.md', 'b/DPO.md']);
  });

  it('空查询：按目录深度、再按字典序', () => {
    expect(rankPaths(['b/x.md', 'z.md', 'a.md', 'a/b/c.md'], '')).toEqual(['a.md', 'z.md', 'b/x.md', 'a/b/c.md']);
  });

  it('上限：只取前 limit 条', () => {
    const many = Array.from({ length: 80 }, (_, i) => `f${String(i).padStart(2, '0')}.md`);
    expect(rankPaths(many, 'f')).toHaveLength(50);
    expect(rankPaths(many, 'f', 3)).toEqual(['f00.md', 'f01.md', 'f02.md']);
  });
});
