import { describe, it, expect } from 'vitest';
import { createScrollSync, mirrorScroll } from './scrollSync';

const pos = (t: number, l: number) => ({ scrollTop: t, scrollLeft: l });

describe('mirrorScroll', () => {
  it('把 source 写到 target，两个轴都写', () => {
    const t = pos(0, 0);
    expect(mirrorScroll(pos(30, 7), t)).toBe(true);
    expect(t).toEqual(pos(30, 7));
  });
  it('同值不写，返回 false（写了会触发无意义的 scroll 事件）', () => {
    const t = pos(30, 7);
    expect(mirrorScroll(pos(30, 7), t)).toBe(false);
  });
});

describe('createScrollSync：回声锁 + 一帧释放', () => {
  // schedule 收进队列，测试自己决定「这一帧结束」的时刻
  const frame = () => { const q: (() => void)[] = []; return { schedule: (cb: () => void) => q.push(cb), flush: () => { q.splice(0).forEach((f) => f()); } }; };

  it('A 滚 → B 被写；B 的回声被吞；帧结束后 B 真滚 → A 被写', () => {
    const { schedule, flush } = frame();
    const sync = createScrollSync(schedule);
    const a = pos(0, 0), b = pos(0, 0);
    a.scrollTop = 100;
    expect(sync(a, b)).toBe(true);           // A → B
    expect(b.scrollTop).toBe(100);
    expect(sync(b, a)).toBe(false);          // 这是 B 的回声，吞掉，A 不动
    flush();
    b.scrollTop = 250;
    expect(sync(b, a)).toBe(true);           // 帧结束后 B 真的滚了 → A 跟上
    expect(a.scrollTop).toBe(250);
  });

  it('回声没来（浏览器没派发或值被夹到相同）→ 帧结束后照样解锁，不会吞掉下一次真实滚动', () => {
    const { schedule, flush } = frame();
    const sync = createScrollSync(schedule);
    const a = pos(0, 0), b = pos(0, 0);
    a.scrollTop = 100; sync(a, b);
    flush();                                 // 没有回声，直接到帧尾
    b.scrollTop = 300;
    expect(sync(b, a)).toBe(true);
    expect(a.scrollTop).toBe(300);
  });

  it('source 在同一帧里连滚两次都镜像过去（锁只挡回声，不挡 source）', () => {
    const { schedule } = frame();
    const sync = createScrollSync(schedule);
    const a = pos(0, 0), b = pos(0, 0);
    a.scrollTop = 10; expect(sync(a, b)).toBe(true);
    a.scrollTop = 20; expect(sync(a, b)).toBe(true);
    expect(b.scrollTop).toBe(20);
  });

  it('同值不写也不上锁', () => {
    const { schedule } = frame();
    const sync = createScrollSync(schedule);
    const a = pos(5, 5), b = pos(5, 5);
    expect(sync(a, b)).toBe(false);
    b.scrollTop = 9;
    expect(sync(b, a)).toBe(true);           // 没被当成回声
  });
});
