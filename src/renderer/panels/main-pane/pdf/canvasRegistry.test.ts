import { describe, it, expect, vi } from 'vitest';
import { cellKey, createCanvasRegistry } from './canvasRegistry';

describe('canvasRegistry', () => {
  const fake = () => ({} as unknown as HTMLCanvasElement);
  it('set 后 get 得到，订阅者被叫一次', () => {
    const r = createCanvasRegistry();
    const cb = vi.fn();
    r.subscribe(cellKey(1, 3), cb);
    const c = fake();
    r.set(cellKey(1, 3), c);
    expect(r.get(cellKey(1, 3))).toBe(c);
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('同一个 canvas 重复 set 不叫订阅者', () => {
    const r = createCanvasRegistry();
    const cb = vi.fn();
    r.subscribe('k', cb);
    const c = fake();
    r.set('k', c); r.set('k', c);
    expect(cb).toHaveBeenCalledTimes(1);
  });
  it('set(null) 删除并通知', () => {
    const r = createCanvasRegistry();
    const cb = vi.fn();
    r.subscribe('k', cb);
    r.set('k', fake()); r.set('k', null);
    expect(r.get('k')).toBeNull();
    expect(cb).toHaveBeenCalledTimes(2);
  });
  it('退订后不再通知；别的 key 的 set 不惊动这个订阅者', () => {
    const r = createCanvasRegistry();
    const cb = vi.fn();
    const off = r.subscribe('k', cb);
    r.set('other', fake());
    expect(cb).not.toHaveBeenCalled();
    off();
    r.set('k', fake());
    expect(cb).not.toHaveBeenCalled();
  });
});
