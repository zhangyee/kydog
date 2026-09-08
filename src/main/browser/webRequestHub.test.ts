import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `session.webRequest` 的单一分发点。
 *
 * 被测的那件事只有一个：**每种事件、每个 session 只能挂一个监听器**
 * （`electron.d.ts:18931` 的签名是 `listener | null` —— 是「设置」不是「添加」）。
 * 两处各挂各的，后挂的把前一个顶掉，**且不报错**。所以这里的替身要能数出
 * 「底层被设置了几次」，而不只是「回调有没有被调到」。
 */
const H = vi.hoisted(() => {
  type Listener =
    | ((details: { url: string }, callback: (r: unknown) => void) => void)
    | null;

  /** 照 Electron 的语义：每次调用**覆盖**上一个，不是追加。 */
  class FakeWebRequest {
    /** 被设置过几次（含置 null 那几次）。 */
    sets = 0;
    /** 当前挂着的那一个。null = 已摘。 */
    current: Listener = null;
    onBeforeRequest(listener: Listener): void {
      this.sets += 1;
      this.current = listener;
    }
    /** 让用例扮演 Chromium：打一次请求进来，收集 callback 的调用。 */
    fire(url: string): unknown[] {
      const responses: unknown[] = [];
      if (!this.current) throw new Error('底层没有监听器，这一发打不进来');
      this.current({ url }, (r) => responses.push(r));
      return responses;
    }
  }

  const fake = { wr: new FakeWebRequest(), partitions: [] as string[] };
  const logs: Array<{ scope: string; msg: string; ctx?: unknown }> = [];
  return { FakeWebRequest, fake, logs };
});

vi.mock('electron', () => ({
  session: {
    fromPartition: (p: string) => {
      H.fake.partitions.push(p);
      return { webRequest: H.fake.wr };
    },
  },
}));

vi.mock('../log', () => ({
  logger: {
    debug: () => {}, info: () => {},
    warn: (scope: string, msg: string, ctx?: unknown) => H.logs.push({ scope, msg, ctx }),
    error: (scope: string, msg: string, ctx?: unknown) => H.logs.push({ scope, msg, ctx }),
  },
}));

const { createWebRequestHub, browserWebRequestHub, _resetSharedHubForTest } =
  await import('./webRequestHub');
const { BROWSER_PARTITION } = await import('./partition');

type Wr = InstanceType<typeof H.FakeWebRequest>;
const makeWr = (): Wr => new H.FakeWebRequest();

beforeEach(() => {
  H.fake.wr = new H.FakeWebRequest();
  H.fake.partitions.length = 0;
  H.logs.length = 0;
  _resetSharedHubForTest();
});

describe('onBeforeRequest：多个订阅者共用底层那一个监听器', () => {
  it('两个订阅者都收得到，且底层只挂了一次', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    const seen: string[] = [];
    hub.onBeforeRequest((d) => { seen.push('a:' + d.url); });
    hub.onBeforeRequest((d) => { seen.push('b:' + d.url); });

    expect(wr.sets).toBe(1);
    wr.fire('https://x/');
    expect(seen).toEqual(['a:https://x/', 'b:https://x/']);
  });

  it('一个订阅者都没有时压根不挂 —— 懒挂', () => {
    const wr = makeWr();
    createWebRequestHub(wr as never);
    expect(wr.sets).toBe(0);
    expect(wr.current).toBeNull();
  });

  it('取消订阅之后不再收到，剩下的那个照收', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    const seen: string[] = [];
    const offA = hub.onBeforeRequest((d) => { seen.push('a:' + d.url); });
    hub.onBeforeRequest((d) => { seen.push('b:' + d.url); });

    offA();
    wr.fire('https://x/');
    expect(seen).toEqual(['b:https://x/']);
    // 还有人在，底层不许摘 —— 摘了另一个订阅者就静默失聪。
    expect(wr.current).not.toBeNull();
  });

  it('全退订之后底层置 null —— 懒摘', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    const off1 = hub.onBeforeRequest(() => {});
    const off2 = hub.onBeforeRequest(() => {});
    off1();
    expect(wr.current).not.toBeNull();
    off2();
    expect(wr.current).toBeNull();
    // 摘也是一次「设置」：置 null 走的是同一个 setter。
    expect(wr.sets).toBe(2);
  });

  it('全退订之后再订阅，会重新挂上（不是永久摘掉）', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    hub.onBeforeRequest(() => {})();
    const seen: string[] = [];
    hub.onBeforeRequest((d) => { seen.push(d.url); });
    expect(wr.current).not.toBeNull();
    wr.fire('https://y/');
    expect(seen).toEqual(['https://y/']);
  });

  it('同一个 off 调两次是幂等的，不会把后来的订阅者一起摘掉', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    const off = hub.onBeforeRequest(() => {});
    off();
    const seen: string[] = [];
    hub.onBeforeRequest((d) => { seen.push(d.url); });
    off();                       // 第二次：它管的那个已经走了，不许波及别人
    expect(wr.current).not.toBeNull();
    wr.fire('https://z/');
    expect(seen).toEqual(['https://z/']);
  });
});

/**
 * `onBeforeRequest` 的 callback **必须被调到，而且只调一次**：不调，那一条请求
 * 就永远挂在那里（不是失败、不报错，是页面永远转圈）；调两次，Electron 那侧
 * 是一次未定义行为。订阅者是**观测者**，没有改判的口子 —— 多个订阅者各自
 * `cancel` / `redirectURL` 根本无法合并，所以这里连让它们表态的机会都不给。
 */
describe('放行：callback 恰好一次，且订阅者改不了判', () => {
  it('没有订阅者抛错时，callback 调一次、载荷是空对象（不取消、不改写）', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    hub.onBeforeRequest(() => {});
    expect(wr.fire('https://x/')).toEqual([{}]);
  });

  it('订阅者抛了：其余订阅者照收，且照样放行一次', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    const seen: string[] = [];
    hub.onBeforeRequest(() => { throw new Error('订阅者自己炸了'); });
    hub.onBeforeRequest((d) => { seen.push(d.url); });

    expect(wr.fire('https://x/')).toEqual([{}]);
    expect(seen).toEqual(['https://x/']);
  });

  it('订阅者抛了要留痕，但**日志里不许有网址**（凭据在 userinfo 里）', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    hub.onBeforeRequest(() => { throw new Error('boom'); });
    wr.fire('https://user:hunter2@evil.example/secret?token=abc');

    expect(H.logs).toHaveLength(1);
    const dump = JSON.stringify(H.logs);
    expect(dump).toContain('boom');
    for (const leak of ['evil.example', 'hunter2', 'secret', 'token=abc']) {
      expect(dump).not.toContain(leak);
    }
  });

  it('分发途中退订自己，不影响本次派发里其余订阅者', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    const seen: string[] = [];
    const off = hub.onBeforeRequest((d) => { seen.push('a:' + d.url); off(); });
    hub.onBeforeRequest((d) => { seen.push('b:' + d.url); });

    expect(wr.fire('https://x/')).toEqual([{}]);
    expect(seen).toEqual(['a:https://x/', 'b:https://x/']);
    // 下一发它就不该在了。
    seen.length = 0;
    wr.fire('https://x/');
    expect(seen).toEqual(['b:https://x/']);
  });

  /**
   * **本次派发的名单在派发开始那一刻就定下来。**
   *
   * 上面那条守不住这件事 —— 退订**自己**时，`Set` 直接迭代与迭代副本行为一样
   * （删掉的是已经走过的那一个）。真正分得开两者的是「退订**排在后面的**那一个」：
   * 直接迭代 `Set` 会当场跳过它（这一发它就静默失聪了），迭代副本才照发。
   * 这条是第二轮变异自查里那条**存活的**变异逼出来的。
   */
  it('分发途中退订别人：这一发对方照收，下一发才没有', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    const seen: string[] = [];
    let offB = (): void => {};
    hub.onBeforeRequest((d) => { seen.push('a:' + d.url); offB(); });
    offB = hub.onBeforeRequest((d) => { seen.push('b:' + d.url); });

    wr.fire('https://x/');
    expect(seen).toEqual(['a:https://x/', 'b:https://x/']);
    seen.length = 0;
    wr.fire('https://x/');
    expect(seen).toEqual(['a:https://x/']);
  });

  it('分发途中新订阅：这一发轮不到它，下一发才收得到', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    const seen: string[] = [];
    let added = false;
    hub.onBeforeRequest((d) => {
      seen.push('a:' + d.url);
      if (!added) { added = true; hub.onBeforeRequest((e) => { seen.push('c:' + e.url); }); }
    });

    wr.fire('https://x/');
    expect(seen).toEqual(['a:https://x/']);
    seen.length = 0;
    wr.fire('https://x/');
    expect(seen).toEqual(['a:https://x/', 'c:https://x/']);
  });
});

/**
 * 共用实例。**这一条才是「Task 7 不必自己去挂」的全部保障** ——
 * 每人自己 `createWebRequestHub(session.fromPartition(...).webRequest)` 的话，
 * 两个 hub 各挂各的，后建的那个把先建的顶掉，回到原点且不报错。
 */
describe('browserWebRequestHub()：整个进程一个实例，绑在浏览器分区上', () => {
  it('两次调用是同一个实例，底层 session 只取一次', () => {
    const a = browserWebRequestHub();
    const b = browserWebRequestHub();
    expect(a).toBe(b);
    expect(H.fake.partitions).toEqual([BROWSER_PARTITION]);
  });

  it('两次拿到的 hub 共用同一个底层监听器：一次 fire 两边都收得到', () => {
    const seen: string[] = [];
    browserWebRequestHub().onBeforeRequest((d) => { seen.push('a:' + d.url); });
    browserWebRequestHub().onBeforeRequest((d) => { seen.push('b:' + d.url); });
    expect(H.fake.wr.sets).toBe(1);
    H.fake.wr.fire('https://x/');
    expect(seen).toEqual(['a:https://x/', 'b:https://x/']);
  });

  it('绑的是浏览器那个持久分区，不是默认 session', () => {
    browserWebRequestHub();
    expect(H.fake.partitions).toEqual(['persist:kydog-browser']);
  });
});
