import { describe, it, expect } from 'vitest';
import { rankPaths, buildPathIndex, searchPathIndex } from './fuzzyPath';

/** 线上走的那条路（先建索引、再查）；每条排序用例两条路都跑一遍。 */
const viaIndex = (paths: readonly string[], query: string, limit?: number) => searchPathIndex(buildPathIndex(paths), query, limit);
const RANKERS = [['rankPaths（定义）', rankPaths], ['buildPathIndex + searchPathIndex（线上）', viaIndex]] as const;

describe.each(RANKERS)('排序语义：%s', (_name, rank) => {
  it('分档：文件名开头 > 文件名连续包含 > 路径连续包含 > 文件名子序列 > 路径子序列；都不中的排除', () => {
    const paths = ['zzz.md', 'd/p/o.txt', 'data/d-p-o.csv', 'dpo/readme.md', 'notes/ipo-vs-dpo.pdf', 'refs/dpo-2023.pdf'];
    expect(rank(paths, 'dpo')).toEqual([
      'refs/dpo-2023.pdf', 'notes/ipo-vs-dpo.pdf', 'dpo/readme.md', 'data/d-p-o.csv', 'd/p/o.txt',
    ]);
  });

  it('大小写不敏感；同档按路径长度、再按字典序', () => {
    expect(rank(['b/DPO.md', 'a/dpo.md', 'dpo.md'], 'Dpo')).toEqual(['dpo.md', 'a/dpo.md', 'b/DPO.md']);
  });

  it('空查询：按目录深度、再按字典序', () => {
    expect(rank(['b/x.md', 'z.md', 'a.md', 'a/b/c.md'], '')).toEqual(['a.md', 'z.md', 'b/x.md', 'a/b/c.md']);
  });

  it('上限：只取前 limit 条', () => {
    const many = Array.from({ length: 80 }, (_, i) => `f${String(i).padStart(2, '0')}.md`);
    expect(rank(many, 'f')).toHaveLength(50);
    expect(rank(many, 'f', 3)).toEqual(['f00.md', 'f01.md', 'f02.md']);
  });
});

describe('buildPathIndex + searchPathIndex 与 rankPaths 逐条相同（F3：线上不再整体排序，排序语义不许变）', () => {
  // 手挑的：大小写混排、同名不同目录、同长度靠字典序定先后、只有子序列才中的、非 ASCII、重复路径、深浅不一。
  const HAND = [
    'README.md', 'readme.md', 'ReadMe.MD', 'docs/README.md', 'docs/readme-zh.md', 'a/b/c/d/e/readme.md',
    'refs/dpo-2023.pdf', 'refs/DPO-2024.pdf', 'refs/ppo.pdf', 'notes/ipo-vs-dpo.pdf', 'd/p/o.txt', 'data/d-p-o.csv',
    'dpo/readme.md', 'DPO/Readme.md', 'x/dpo', 'dpo', 'Dpo', 'src/a.ts', 'src/b.ts', 'src/ab.ts', 'src/ba.ts',
    '文献/综述.md', '文献/综述-初稿.md', 'Ärger/Übersicht.md', 'ärger/übersicht.md', 'z/zz/zzz.md',
    'refs/dpo-2023.pdf', 'figures/fig1.png', 'figures/Fig10.png', 'figures/fig2.png', '.hidden-not-listed-but-ok',
  ];
  // 生成的：3000 条，大量同档、同长度的并列，逼出 top-k 的边界（第 50 名附近的先后）。
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const words = ['src', 'data', 'Data', 'refs', 'dpo', 'DPO', 'ppo', 'notes', 'paper', 'fig', 'a', 'b', 'ab', '综述'];
  const exts = ['.md', '.pdf', '.ts', ''];
  const GEN = Array.from({ length: 3000 }, () => {
    const depth = 1 + Math.floor(rnd() * 4);
    const parts = Array.from({ length: depth }, () => words[Math.floor(rnd() * words.length)]);
    parts[depth - 1] += exts[Math.floor(rnd() * exts.length)];
    return parts.join('/');
  });
  const QUERIES = ['', 'd', 'D', 'dpo', 'DPO', 'rdm', 'readme', 'md', '.pdf', '/', 'a/b', 'ab', 'zzz', 'qqq', '综述', 'über', 'ÜBER', 'fig1', 's/a'];
  const LIMITS = [undefined, 1, 3, 50, 80, 5000];

  it.each([['手挑', HAND], ['生成', GEN]] as const)('%s的夹具：每个查询 × 每个上限都与 rankPaths 相同', (_name, paths) => {
    const index = buildPathIndex(paths);
    let nonEmpty = 0;
    for (const q of QUERIES) {
      for (const limit of LIMITS) {
        const want = rankPaths(paths, q, limit);
        expect(searchPathIndex(index, q, limit), `q=${JSON.stringify(q)} limit=${String(limit)}`).toEqual(want);
        if (want.length > 0) nonEmpty += 1;
      }
    }
    // 正向：比的不是一堆空列表 —— 绝大多数组合确实有结果（夹具或查询被改坏时这里先红）。
    expect(nonEmpty).toBeGreaterThan(QUERIES.length * LIMITS.length / 2);
  });

  it('空查询的前 50 名扫完时就算好；上限超过 50 时照样给出与 rankPaths 相同的更长结果', () => {
    const index = buildPathIndex(GEN);
    expect(index.emptyTop).toEqual(rankPaths(GEN, '', 50));
    expect(searchPathIndex(index, '', 120)).toEqual(rankPaths(GEN, '', 120));
    expect(searchPathIndex(index, '', 120)).toHaveLength(120);
  });
});
