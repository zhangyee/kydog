import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

vi.mock('../log', () => ({ logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));

import { FileWatcherService, type WatchFn } from './fileWatcher';

/** 替身 fs.watch：记下开过哪些目录，事件由用例手动打进去。 */
function fakeWatch() {
  type H = { dir: string; closed: boolean; fire: (type: string, name: string | null) => void; fail: (err: Error) => void; close(): void };
  const opened: H[] = [];
  const failing = new Set<string>();
  const watch: WatchFn = (dir, onEvent, onError) => {
    if (failing.has(dir)) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
    const h: H = { dir, closed: false, fire: onEvent, fail: onError, close() { h.closed = true; } };
    opened.push(h);
    return h;
  };
  const live = () => opened.filter((h) => !h.closed).map((h) => h.dir).sort();
  const handle = (dir: string) => {
    const hs = opened.filter((h) => h.dir === dir && !h.closed);
    if (hs.length !== 1) throw new Error(`${dir} 上开着 ${String(hs.length)} 个句柄`);
    return hs[0];
  };
  return { watch, opened, failing, live, handle };
}

function setup() {
  const fw = fakeWatch();
  const emitDir = vi.fn();
  const emitFile = vi.fn();
  const svc = new FileWatcherService({ debounceMs: 50, emitDir, emitFile, watch: fw.watch });
  return { ...fw, emitDir, emitFile, svc };
}

describe('FileWatcherService：只盯声明过的东西', () => {
  it('一个目录一个句柄；文件盯它所在的目录；不往下递归', () => {
    const { svc, live, opened } = setup();
    svc.set(1, { dirs: ['/p'], files: ['/p/sub/a.md'] });
    // /p/sub 只因为 a.md 在里面才开；/p 下面别的子目录一个都不开 —— 以前 chokidar 在这里整树扫描。
    expect(live()).toEqual(['/p', '/p/sub']);
    expect(opened).toHaveLength(2);
  });

  it('整份替换：撤掉的目录关句柄，没变的不重开', () => {
    const { svc, live, opened } = setup();
    svc.set(1, { dirs: ['/p', '/p/x'], files: [] });
    expect(live()).toEqual(['/p', '/p/x']);
    svc.set(1, { dirs: ['/p'], files: [] });
    expect(live()).toEqual(['/p']);
    // /p 还是原来那一个，没有关了再开。
    expect(opened.filter((h) => h.dir === '/p')).toHaveLength(1);
  });

  it('按窗口分账：一个窗口撤掉，另一个窗口还在看的目录不关', () => {
    const { svc, live } = setup();
    svc.set(1, { dirs: ['/p', '/shared'], files: [] });
    svc.set(2, { dirs: ['/shared'], files: ['/q/r.md'] });
    expect(live()).toEqual(['/p', '/q', '/shared']);
    svc.forget(1);
    expect(live()).toEqual(['/q', '/shared']);
    svc.stopAll();
    expect(live()).toEqual([]);
  });

  it('开不了的目录（被删了 / 没权限）跳过，不连累别的', () => {
    const { svc, live, failing } = setup();
    failing.add('/gone');
    expect(() => svc.set(1, { dirs: ['/gone', '/p'], files: [] })).not.toThrow();
    expect(live()).toEqual(['/p']);
  });
});

describe('FileWatcherService：事件怎么分流', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('列表里的条目出现/消失（rename）→ fs.changed 带那个目录；内容改动（change）不动列表', async () => {
    const { svc, handle, emitDir, emitFile } = setup();
    svc.set(1, { dirs: ['/p'], files: [] });

    handle('/p').fire('change', 'a.md');
    await vi.advanceTimersByTimeAsync(60);
    expect(emitDir).not.toHaveBeenCalled();

    handle('/p').fire('rename', 'new.md');
    await vi.advanceTimersByTimeAsync(60);
    expect(emitDir).toHaveBeenCalledTimes(1);
    expect(emitDir).toHaveBeenCalledWith('/p');
    expect(emitFile).not.toHaveBeenCalled();
  });

  it('列表里不显示的条目（点号开头、node_modules）变了，不让渲染层重读', async () => {
    const { svc, handle, emitDir } = setup();
    svc.set(1, { dirs: ['/p'], files: [] });

    handle('/p').fire('rename', '.paper.pdf.json');
    handle('/p').fire('rename', 'node_modules');
    await vi.advanceTimersByTimeAsync(60);
    expect(emitDir).not.toHaveBeenCalled();

    // 同一个目录、同一种事件，换成列表里有的名字就发：上面没发不是因为句柄没接上。
    handle('/p').fire('rename', 'paper.pdf');
    await vi.advanceTimersByTimeAsync(60);
    expect(emitDir).toHaveBeenCalledWith('/p');
  });

  it('声明过的文件：改写（change）与原子替换（rename）都发 file.changed，带声明时那串路径', async () => {
    const { svc, handle, emitFile } = setup();
    svc.set(1, { dirs: [], files: ['/p/a.md', '/p/b.html'] });

    handle('/p').fire('change', 'a.md');
    handle('/p').fire('rename', 'b.html');
    await vi.advanceTimersByTimeAsync(60);
    expect(emitFile.mock.calls.map((c) => c[0] as string).sort()).toEqual(['/p/a.md', '/p/b.html']);
  });

  it('目录只因为里面有打开的文件才被盯：兄弟文件变了不发，列表也不刷', async () => {
    const { svc, handle, emitDir, emitFile } = setup();
    svc.set(1, { dirs: [], files: ['/q/r.md'] });

    handle('/q').fire('rename', 'other.md');
    handle('/q').fire('change', 'other.md');
    await vi.advanceTimersByTimeAsync(60);
    expect(emitFile).not.toHaveBeenCalled();
    expect(emitDir).not.toHaveBeenCalled();

    // 正向：同一个句柄上，点到那个文件就发。
    handle('/q').fire('rename', 'r.md');
    await vi.advanceTimersByTimeAsync(60);
    expect(emitFile).toHaveBeenCalledWith('/q/r.md');
    // /q 不在 dirs 里：即使是 rename，也没人缓存它的列表。
    expect(emitDir).not.toHaveBeenCalled();
  });

  it('平台没给文件名：这个目录与目录里声明过的文件都发，别的目录不发', async () => {
    const { svc, handle, emitDir, emitFile } = setup();
    svc.set(1, { dirs: ['/p'], files: ['/p/a.md', '/q/r.md'] });

    handle('/p').fire('change', null);
    await vi.advanceTimersByTimeAsync(60);
    expect(emitDir.mock.calls).toEqual([['/p']]);
    expect(emitFile.mock.calls).toEqual([['/p/a.md']]);
  });

  it('同一个目录的一串事件合成一条', async () => {
    const { svc, handle, emitDir } = setup();
    svc.set(1, { dirs: ['/p'], files: [] });
    handle('/p').fire('rename', 'a.md.tmp.1');
    handle('/p').fire('rename', 'a.md.tmp.1');
    handle('/p').fire('rename', 'a.md');
    await vi.advanceTimersByTimeAsync(60);
    expect(emitDir).toHaveBeenCalledTimes(1);
  });

  it('撤掉之后，还没到点的那条不再冒出来', async () => {
    const { svc, handle, emitDir, emitFile } = setup();
    svc.set(1, { dirs: ['/p'], files: ['/p/a.md'] });

    // 对照：不撤就会发。
    handle('/p').fire('rename', 'a.md');
    await vi.advanceTimersByTimeAsync(60);
    expect(emitDir).toHaveBeenCalledTimes(1);
    expect(emitFile).toHaveBeenCalledTimes(1);

    handle('/p').fire('rename', 'a.md');
    svc.set(1, { dirs: [], files: [] });
    await vi.advanceTimersByTimeAsync(60);
    expect(emitDir).toHaveBeenCalledTimes(1);
    expect(emitFile).toHaveBeenCalledTimes(1);
  });

  it('句柄出错（目录本身被删）：关掉它，并让渲染层重读一次去拿真实的错误', async () => {
    const { svc, handle, live, emitDir } = setup();
    svc.set(1, { dirs: ['/p', '/p/x'], files: [] });
    handle('/p/x').fail(new Error('EPERM'));
    expect(live()).toEqual(['/p']);
    await vi.advanceTimersByTimeAsync(60);
    expect(emitDir.mock.calls).toEqual([['/p/x']]);

    // 渲染层还声明着它（比如目录又建回来了），下一次声明会重新开。
    svc.set(1, { dirs: ['/p', '/p/x'], files: [] });
    expect(live()).toEqual(['/p', '/p/x']);
  });
});

describe('FileWatcherService：接真的 fs.watch', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-fw-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('新建文件 → fs.changed 带目录；改写已声明的文件 → file.changed 带路径', async () => {
    const f = path.join(tmp, 'a.html');
    await fs.writeFile(f, '<h1>v1</h1>');
    const emitDir = vi.fn();
    const emitFile = vi.fn();
    const svc = new FileWatcherService({ debounceMs: 20, emitDir, emitFile });
    svc.set(1, { dirs: [tmp], files: [f] });
    expect(svc.watchedDirs()).toEqual([tmp]);
    try {
      // macOS 的 FSEvents 要一小会儿才开始报：先等它就位，不然开头那次写可能落在它之前。
      await new Promise((r) => setTimeout(r, 150));
      await fs.writeFile(path.join(tmp, 'report.md'), '# hi');
      await vi.waitFor(() => { expect(emitDir).toHaveBeenCalledWith(tmp); }, { timeout: 3000 });

      await fs.writeFile(f, '<h1>v2</h1>');
      await vi.waitFor(() => { expect(emitFile).toHaveBeenCalledWith(f); }, { timeout: 3000 });
    } finally {
      svc.stopAll();
    }
    expect(svc.watchedDirs()).toEqual([]);
  });
});
