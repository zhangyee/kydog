import { describe, it, expect } from 'vitest';
import { createScrollSync, mirrorScroll, type ScrollPos } from './scrollSync';

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
  // schedule 收进队列，测试自己决定「这一帧结束」的时刻。
  // `step` 只放行**最早排下的那一个**回调：有两把锁先后上过时，「旧那一帧的解锁回调跑到了」
  // 这件事必须能单独发生，全 flush 会把后上的那把锁一起解掉，观察不到守卫。
  const frame = () => {
    const q: (() => void)[] = [];
    return {
      schedule: (cb: () => void) => q.push(cb),
      flush: () => { q.splice(0).forEach((f) => f()); },
      step: () => { q.shift()!(); },
    };
  };

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

  /**
   * 会**夹取**的假滚动容器：写超出上界的值进去，位置停在上界，同真 DOM。
   *
   * 两栏的上界确实可以不同（spec §3.1「诚实的代价」：不等宽时一栏有占位横向滚动条另一栏没有，
   * clientHeight 差一条，纵向 maxScrollTop 跟着差这么多）。回声锁要挡的正是「被夹过的那个值
   * 原路写回去，把对面从用户刚滚到的位置拽走」——上界相同的假对象里这件事根本不会发生。
   */
  const clamped = (maxTop: number): ScrollPos => {
    let top = 0;
    return {
      get scrollTop() { return top; },
      set scrollTop(v: number) { top = Math.min(maxTop, Math.max(0, v)); },
      scrollLeft: 0,
    };
  };

  it('旧帧的解锁回调只解自己上的那把锁——`if (echoFrom === target)` 守卫', () => {
    // 这条走的是「一帧里两个方向各上过一次锁」的序列，`schedule` 回调里那个判断在这里才有话说：
    // 它闭包里的 target 是**排它那一刻**锁住的元素，而 echoFrom 此刻已经换成另一个了。没有这个
    // 判断，旧回调会把新上的那把锁一起解掉，紧接着到达的回声就被当成真实滚动镜像回去。
    const { schedule, step } = frame();
    const sync = createScrollSync(schedule);
    const a = clamped(200);   // 纵向上界更小的那一栏
    const b = clamped(500);

    // ① A 真滚到 50 → 写 B，锁住 B（排下回调 #1，闭包里的 target 是 b）
    a.scrollTop = 50;
    expect(sync(a, b)).toBe(true);
    expect(b.scrollTop).toBe(50);
    // ② B 的回声按约定被吞，b 那把锁当场解掉；回调 #1 **仍排在队里**
    expect(sync(b, a)).toBe(false);
    // ③ 同一帧里 B 又被用户真的滚到 350 → 写 A，A 把它夹到自己的上界 200。这次锁住的是 **a**
    //    （排下回调 #2，target 是 a）
    b.scrollTop = 350;
    expect(sync(b, a)).toBe(true);
    expect(a.scrollTop, 'A 的上界更小，写进去的值被夹').toBe(200);
    // ④ 现在回调 #1 才跑到。它的 target 是 b，而 echoFrom 已经换成 a —— 守卫在这里挡住
    step();
    // ⑤ A 因为③那次写而发出的回声随后到达，仍应当被吞。去掉守卫的话 ④ 已经把 a 的锁清了，
    //    这里会把「被夹过的 200」当成真实滚动镜像回 B，把用户刚滚到的 350 拽回 200。
    expect(sync(a, b)).toBe(false);
    expect(b.scrollTop, 'B 应当稳稳停在用户滚到的 350，不被夹过的回声拽走').toBe(350);
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
