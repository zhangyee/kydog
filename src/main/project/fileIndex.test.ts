import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { walkProjectFiles, createFileIndex, type ReadDirFn } from './fileIndex';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));
vi.mock('../log', () => ({ logger: { warn: vi.fn() } }));

const ROOT = path.join(path.sep, 'p');
type E = { name: string; dir?: boolean };

function fakeFs(tree: Record<string, E[] | 'fail'>) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const readDir: ReadDirFn = async (dir) => {
    calls.push(dir);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    const rel = path.relative(ROOT, dir).split(path.sep).join('/');
    const entries = tree[rel];
    if (entries === 'fail' || entries === undefined) throw new Error('EACCES');
    return entries.map((e) => ({ name: e.name, isDirectory: e.dir === true }));
  };
  return { readDir, calls, maxInFlight: () => maxInFlight };
}

describe('walkProjectFiles', () => {
  it('按文件树同一套规则：跳过 . 开头与 node_modules，读不了的目录跳过、其余照常', async () => {
    const fs = fakeFs({
      '': [{ name: 'a.md' }, { name: '.git', dir: true }, { name: 'node_modules', dir: true }, { name: '.env' }, { name: 'src', dir: true }, { name: 'bad', dir: true }],
      src: [{ name: 'x.ts' }, { name: 'deep', dir: true }],
      'src/deep': [{ name: 'y.md' }],
      bad: 'fail',
    });
    const files = await walkProjectFiles(ROOT, fs.readDir);
    expect(files.sort()).toEqual(['a.md', 'src/deep/y.md', 'src/x.ts']);
    // .git 与 node_modules 连读都没读（被跳过的是目录本身，不是读完再丢）
    expect(fs.calls.map((c) => path.basename(c))).toContain('src');
    expect(fs.calls.some((c) => c.endsWith(`${path.sep}.git`) || c.endsWith(`${path.sep}node_modules`))).toBe(false);
  });

  it('同一时间只有一个 readdir 在飞（09-21 大项目拖垮 fs 的教训）', async () => {
    const fs = fakeFs({
      '': [{ name: 'a', dir: true }, { name: 'b', dir: true }, { name: 'c', dir: true }],
      a: [{ name: '1.md' }], b: [{ name: '2.md' }], c: [{ name: '3.md' }],
    });
    await walkProjectFiles(ROOT, fs.readDir);
    expect(fs.calls).toHaveLength(4);
    expect(fs.maxInFlight()).toBe(1);
  });
});

describe('createFileIndex', () => {
  it('扫完之前 indexed=false；同一项目重复请求重扫只起一趟；扫完广播、之后按排序给结果', async () => {
    let release!: (files: string[]) => void;
    const walk = vi.fn(() => new Promise<string[]>((r) => { release = r; }));
    const onUpdated = vi.fn();
    const index = createFileIndex({ walk, onUpdated });

    expect(index.search({ projectPath: '/p', query: 'dpo', rescan: true })).toEqual({ items: [], indexed: false });
    index.search({ projectPath: '/p', query: 'dp', rescan: true });
    expect(walk).toHaveBeenCalledTimes(1);

    release(['notes/ipo-vs-dpo.pdf', 'refs/dpo-2023.pdf', 'zzz.md']);
    await index.rescan('/p');
    expect(onUpdated).toHaveBeenCalledWith('/p');
    expect(index.search({ projectPath: '/p', query: 'dpo' })).toEqual({
      items: [{ path: 'refs/dpo-2023.pdf' }, { path: 'notes/ipo-vs-dpo.pdf' }], indexed: true,
    });
  });

  it('扫完之后再请求重扫：手上的结果照常可用，同时后台起新的一趟', async () => {
    const walk = vi.fn().mockResolvedValueOnce(['a.md']).mockResolvedValueOnce(['a.md', 'b.md']);
    const index = createFileIndex({ walk, onUpdated: () => {} });
    await index.rescan('/p');
    expect(index.search({ projectPath: '/p', query: '', rescan: true }).items).toEqual([{ path: 'a.md' }]);
    expect(walk).toHaveBeenCalledTimes(2);
    await index.rescan('/p');
    expect(index.search({ projectPath: '/p', query: '' }).items).toEqual([{ path: 'a.md' }, { path: 'b.md' }]);
  });

  it('walk 拒绝时：接住这个错误、log 它、保留之前的 files、还是调 onUpdated、之后可以再扫', async () => {
    const walk = vi.fn()
      .mockResolvedValueOnce(['a.md'])
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockResolvedValueOnce(['a.md', 'c.md']);
    const onUpdated = vi.fn();
    const index = createFileIndex({ walk, onUpdated });

    // 正向证明：第一趟成功
    await index.rescan('/p');
    expect(index.search({ projectPath: '/p', query: '' })).toEqual({
      items: [{ path: 'a.md' }], indexed: true,
    });
    expect(walk).toHaveBeenCalledTimes(1);
    expect(onUpdated).toHaveBeenCalledTimes(1);

    // 第二趟拒绝
    const failedPromise = index.rescan('/p');
    expect(failedPromise).toBeDefined();
    await expect(failedPromise).resolves.toBeUndefined();
    expect(walk).toHaveBeenCalledTimes(2);

    // 旧结果照样在
    expect(index.search({ projectPath: '/p', query: '' })).toEqual({
      items: [{ path: 'a.md' }], indexed: true,
    });

    // onUpdated 被调过（包括这次拒绝的）
    expect(onUpdated).toHaveBeenCalledTimes(2);

    // 第三趟可以开始
    await index.rescan('/p');
    expect(walk).toHaveBeenCalledTimes(3);
    expect(index.search({ projectPath: '/p', query: '' })).toEqual({
      items: [{ path: 'a.md' }, { path: 'c.md' }], indexed: true,
    });
  });
});
