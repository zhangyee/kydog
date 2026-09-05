import { describe, expect, it } from 'vitest';
import { createPageLifecycle, type Cleanable } from './pageLifecycle';

function harness() {
  const calls: number[] = [];
  const proxies = new Map<number, Cleanable>();
  const get = (p: number) => {
    if (!proxies.has(p)) proxies.set(p, { cleanup: () => calls.push(p) });
    return proxies.get(p);
  };
  const queue: (() => void)[] = [];
  const lc = createPageLifecycle(get, (fn) => queue.push(fn));
  return { lc, calls, drain: () => { while (queue.length) queue.shift()!(); } };
}

describe('createPageLifecycle', () => {
  it('还有层持有时不清理', () => {
    const { lc, calls, drain } = harness();
    lc.acquire(3); lc.acquire(3);   // 双缓冲：两层各一格
    lc.release(3);                   // 旧层卸载
    drain();
    expect(calls).toEqual([]);
  });

  it('引用归零且不在窗口内才清理', () => {
    const { lc, calls, drain } = harness();
    lc.acquire(3);
    lc.release(3);
    drain();
    expect(calls).toEqual([3]);
    expect(lc.cleanedCount()).toBe(1);
  });

  it('引用归零但仍在窗口内则不清理', () => {
    const { lc, calls, drain } = harness();
    lc.acquire(3);
    lc.release(3);
    lc.sweep((p) => p === 3);        // 窗口里还有它
    drain();
    expect(calls).toEqual([]);
  });

  it('排队后又被重新挂载则取消这次清理', () => {
    const { lc, calls, drain } = harness();
    lc.acquire(3);
    lc.release(3);
    lc.acquire(3);                   // 快速来回滚，同一页又进窗口了
    drain();
    expect(calls).toEqual([]);
  });

  it('sweep 补清那些引用早归零、当时还在窗口里的页', () => {
    const { lc, calls, drain } = harness();
    lc.acquire(3);
    lc.release(3);
    lc.sweep((p) => p === 3);
    drain();
    expect(calls).toEqual([]);
    lc.sweep(() => false);            // 窗口挪走了
    drain();
    expect(calls).toEqual([3]);
  });

  /**
   * 翻译抽取那条路（不变量 #8）。proxy 由调用方直接交进来，因为那些页从来没 acquire 过、
   * 也不一定在 pageProxies 里——sweep / release 那条路的 getProxy 找不到它们。
   */
  describe('cleanupIfIdle', () => {
    it('不在窗口内且没人持有 → 当场清，计入 cleanedCount', () => {
      const { lc, calls } = harness();
      const proxy = { cleanup: () => calls.push(7) };
      lc.cleanupIfIdle(7, proxy, false);
      expect(calls).toEqual([7]);
      expect(lc.cleanedCount()).toBe(1);
    });

    it('还在窗口内 → 不清（马上要画它，清了等于白抽）', () => {
      const { lc, calls } = harness();
      lc.cleanupIfIdle(7, { cleanup: () => calls.push(7) }, true);
      expect(calls).toEqual([]);
      expect(lc.cleanedCount()).toBe(0);
    });

    it('还有层持有 → 不清（cleanup() 会打断在途的渲染）', () => {
      const { lc, calls } = harness();
      lc.acquire(7);
      lc.cleanupIfIdle(7, { cleanup: () => calls.push(7) }, false);
      expect(calls).toEqual([]);
    });

    it('顶掉已经排队的那次清理，同一页不会清两次、也不虚增计数', () => {
      const { lc, calls, drain } = harness();
      lc.acquire(7);
      lc.release(7);                                     // 排了一次清理，还没跑到
      lc.cleanupIfIdle(7, { cleanup: () => calls.push(7) }, false);
      drain();                                           // 排队的那次现在跑
      expect(calls).toEqual([7]);
      expect(lc.cleanedCount()).toBe(1);
    });
  });

  it('proxy 还没有时不抛，也不计入清理数（探针要分得清「清了」与「决定要清」）', () => {
    const lc = createPageLifecycle(() => undefined, (fn) => fn());
    lc.acquire(9);
    expect(() => lc.release(9)).not.toThrow();
    expect(lc.cleanedCount()).toBe(0);
  });
});
