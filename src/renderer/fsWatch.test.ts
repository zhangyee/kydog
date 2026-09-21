import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useUiStore } from './stores/uiStore';
import { installWatchSync, loadDir, currentWatchSet } from './fsWatch';

/** 按发生次序记下每一次 invoke；readDir 的结果由用例手动放行。 */
let calls: Array<{ method: string; args: unknown }> = [];
let pendingReads: Array<{ path: string; resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
let off: () => void = () => {};

beforeEach(() => {
  calls = [];
  pendingReads = [];
  useUiStore.setState(useUiStore.getInitialState());
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string, args: { path: string }) => {
        calls.push({ method, args });
        if (method === 'project.readDir') {
          return new Promise((resolve, reject) => { pendingReads.push({ path: args.path, resolve, reject }); });
        }
        return Promise.resolve(undefined);
      },
    },
  };
});

afterEach(() => {
  off();
  delete (globalThis as unknown as Record<string, unknown>).window;
});

const watchedCalls = () => calls.filter((c) => c.method === 'fs.setWatched').map((c) => c.args);
const settle = () => new Promise<void>((r) => { setTimeout(r, 0); });

describe('installWatchSync', () => {
  it('装上就先发一份（空的也发）：重载之后要整份替换掉上一页声明的那份', () => {
    off = installWatchSync();
    expect(watchedCalls()).toEqual([{ dirs: [], files: [] }]);
  });

  it('跟磁盘走的标签（md / html）进集合，pdf 不进；无关的状态变化不重发', () => {
    off = installWatchSync();
    useUiStore.getState().openFile('/p/a.md');
    useUiStore.getState().openFile('/p/r.html');
    expect(watchedCalls().at(-1)).toEqual({ dirs: [], files: ['/p/a.md', '/p/r.html'] });
    const n = watchedCalls().length;
    // pdf 那次打开没有产生新的一份（集合没变）；换主题同理。
    useUiStore.getState().openFile('/p/x.pdf');
    expect(useUiStore.getState().openFileTabs.map((t) => t.path)).toContain('/p/x.pdf');
    useUiStore.getState().setTheme('midnight');
    expect(watchedCalls()).toHaveLength(n);
    useUiStore.getState().closeFileTab('/p/a.md');
    expect(watchedCalls().at(-1)).toEqual({ dirs: [], files: ['/p/r.html'] });
  });
});

describe('loadDir', () => {
  it('先声明、再读：带着这个目录的 fs.setWatched 排在 project.readDir 之前', async () => {
    off = installWatchSync();
    void loadDir('/p');
    const iWatch = calls.findIndex((c) => c.method === 'fs.setWatched'
      && (c.args as { dirs: string[] }).dirs.includes('/p'));
    const iRead = calls.findIndex((c) => c.method === 'project.readDir');
    expect(iWatch).toBeGreaterThanOrEqual(0);
    expect(iRead).toBeGreaterThanOrEqual(0);
    expect(iWatch).toBeLessThan(iRead);

    pendingReads[0].resolve([{ name: 'a.md', path: '/p/a.md', kind: 'file' }]);
    await settle();
    expect(useUiStore.getState().dirCache['/p']).toEqual([{ name: 'a.md', path: '/p/a.md', kind: 'file' }]);
    // 读完之后仍在集合里（从「在读」换成了「缓存着」）。
    expect(currentWatchSet().dirs).toEqual(['/p']);
  });

  it('读失败：错误落进 store（不再是 unhandled rejection），目录撤出监听集合', async () => {
    off = installWatchSync();
    void loadDir('/p');
    expect(currentWatchSet().dirs).toEqual(['/p']);
    pendingReads[0].reject(new Error('cannot read /p (EPERM)'));
    await settle();
    const s = useUiStore.getState();
    expect(s.dirErrors['/p']).toBe('cannot read /p (EPERM)');
    expect(s.dirCache['/p']).toBeUndefined();
    expect(watchedCalls().at(-1)).toEqual({ dirs: [], files: [] });
  });

  it('读的这段时间里目录不看了（project 被移除）：结果不写回，不把它重新加进集合', async () => {
    off = installWatchSync();
    void loadDir('/p/sub');
    void loadDir('/q');
    useUiStore.getState().dropDirsUnder('/p');
    for (const r of pendingReads) r.resolve([]);
    await settle();
    // 正向：同一批里没被移除的那个照常写回 —— 证明结果确实回来过，不是没等到。
    expect(Object.keys(useUiStore.getState().dirCache)).toEqual(['/q']);
    expect(watchedCalls().at(-1)).toEqual({ dirs: ['/q'], files: [] });
  });
});
