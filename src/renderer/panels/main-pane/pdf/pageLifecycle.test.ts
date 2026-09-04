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

  it('proxy 还没有时不抛，也不计入清理数（探针要分得清「清了」与「决定要清」）', () => {
    const lc = createPageLifecycle(() => undefined, (fn) => fn());
    lc.acquire(9);
    expect(() => lc.release(9)).not.toThrow();
    expect(lc.cleanedCount()).toBe(0);
  });
});
