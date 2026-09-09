import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { stripComments } from '../../test-support/stripComments';

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

  /**
   * **上面那条其实分不开有没有 `done` 闸**：两次 `onBeforeRequest` 传的是两个不同的
   * 闭包，`subs.delete(别人)` 删一个不在集合里的元素本来就无害。
   *
   * 真正分得开的是**同一个函数引用**：订阅者只在 Set 里存一份，重新订阅之后，
   * 第一个 `off()` 若照删不误，删掉的就是**重新订阅的那一份**。真实场景就是 Task 7 的
   * 登录观测 —— 同一个具名观测函数拆了又装，而拆下来的旧 `off` 还在某个 finally 里。
   */
  it('同一个函数重新订阅之后，旧的 off 再调一次不许把新的那一份摘掉', () => {
    const wr = makeWr();
    const hub = createWebRequestHub(wr as never);
    const seen: string[] = [];
    const watcher = (d: { url: string }) => { seen.push(d.url); };

    const off1 = hub.onBeforeRequest(watcher);
    off1();
    hub.onBeforeRequest(watcher);   // 同一个引用，重新装上
    off1();                         // 旧的 off：它管的那一次早就退订了

    expect(wr.current).not.toBeNull();
    wr.fire('https://again/');
    expect(seen).toEqual(['https://again/']);
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

// ── 「不许绕过 hub 自己挂」这条约定的守门人 ──────────────────────────────────

/**
 * 上面所有用例守的都是 **hub 自己**：单例、幂等退订、异常不掀翻别人。
 * 它们守不住的是**别人绕过它**：下一批加一个观测（下载归属、CSP 报告、统计……）
 * 时写一句 `session.fromPartition(BROWSER_PARTITION).webRequest.onBeforeRequest(…)`
 * 就把 hub 的 `dispatch` 顶掉了 —— `loginFlow` 的 SAML 断言回传观测从此一条请求
 * 都收不到，机构登录退化成**永不确认**。
 *
 * **失败形态：静默。** `onBeforeRequest` 是「设置」不是「添加」，顶掉不报错；
 * 三条 gate（tsc / lint / npm test）全绿，运行时零信号。这条约定在本轮之前
 * **只写在 `webRequestHub.ts` 顶部的一段注释里**，没有 lint、没有用例。
 *
 * 判据是**全仓生产源码里 `.webRequest` 只许出现在这一个文件里**，与
 * `eventLedger.test.ts` 的 topic 台账、`slowpaperDocConstants.test.ts` 的常数对账
 * 同一个形状：去注释之后扫真实调用点，不手抄名单。
 */
describe('全仓只有 hub 一处碰 session.webRequest', () => {
  const SRC = path.resolve(__dirname, '..', '..');
  const HUB = path.join(SRC, 'main', 'browser', 'webRequestHub.ts');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { out.push(...walk(full)); continue; }
      if (!/\.tsx?$/.test(e.name)) continue;
      if (e.name.includes('.test.')) continue;     // 用例里的替身不算生产挂点
      out.push(full);
    }
    return out;
  }

  /**
   * 成员访问那一种（`xxx.webRequest`）。**注释与字符串字面量都要先剥掉**：
   * 约定本身就把被禁的写法原样引在注释里（`webRequestHub.ts` 顶部那段、
   * `loginFlow.ts` 的两句说明），而 hub 自己的日志作用域就叫
   * `'browser.webRequest'` —— 两者都不是挂点，算进去这条判据就永远对不上。
   * 挂点不可能藏在字符串里，所以剥掉它们只会让扫描器**少扫**（安全方向）。
   */
  const hits = (src: string) => [
    ...stripComments(src)
      .replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, "''")
      .matchAll(/\.\s*webRequest\b/g),
  ].length;

  const FILES = walk(SRC);

  it('扫描器真的扫到了东西 —— 钉住下面两条不是空绿', () => {
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES).toContain(HUB);
  });

  it('hub 自己有且只有那一处 —— 它是唯一的挂点', () => {
    expect(hits(readFileSync(HUB, 'utf8')),
      'webRequestHub.ts 里 `.webRequest` 的出现次数变了：要么挂点搬走了（那下面那条就在空转），'
      + '要么这里自己多挂了一种事件（那也要有人守）').toBe(1);
  });

  it('除了 hub，生产源码里一处都不许有', () => {
    const offenders = FILES
      .filter((f) => f !== HUB)
      .filter((f) => hits(readFileSync(f, 'utf8')) > 0)
      .map((f) => path.relative(SRC, f));
    expect(offenders,
      '有模块绕过 hub 直接碰 session.webRequest。`onBeforeRequest` 是「设置」不是「添加」：'
      + '后挂的会把 hub 顶掉且不报错，机构登录的 SAML 断言观测从此一条请求都收不到 —— '
      + '三条 gate 全绿，运行时零信号。要观测就经 `browserWebRequestHub().onBeforeRequest(…)` 订阅。')
      .toEqual([]);
  });

  // 注释里原样引着被禁的写法（`webRequestHub.ts` 顶部那段约定、`loginFlow.ts` 的
  // 那两句说明）—— 不剥注释的话上面两条全是假的。
  it('剥注释这一步不是摆设：注释里的 session.webRequest 不算挂点', () => {
    expect(hits("// 不许自己去挂 session.webRequest\nconst a = 1;")).toBe(0);
    expect(hits("/** 见 session.webRequest 那段 */\nconst a = 1;")).toBe(0);
    // 日志作用域那种：串里的 `browser.webRequest` 不是挂点
    expect(hits("logger.warn('browser.webRequest', 'x');")).toBe(0);
    expect(hits('session.fromPartition(P).webRequest.onBeforeRequest(fn);')).toBe(1);
  });
});
