import { describe, it, expect, vi, beforeEach } from 'vitest';
import { describeNav, landedOnPage, ActionSchema, createBrowserTools } from './browserTools';
import { ACTION_KINDS, WAIT_DEFAULT_MS, WAIT_MAX_MS } from '../browser/actions';
import { MAX_BATCH_CHARS } from '../browser/extract';
import { KydogError } from '../../shared/errors';
import type { NavigationObservation } from '../../shared/types';

type Outcome = NavigationObservation['outcome'];
const say = (outcome: Outcome): string => describeNav({ navigationId: 'n1', outcome });

/**
 * 每个终态各一个样本。加了新 kind 而不往这里加一条，下面几条穷尽性断言会红 ——
 * 文案是模型**唯一**读得到的东西，不能再出现「整个 commit 只有文案、零覆盖」。
 */
const SAMPLES = {
  ok: { kind: 'ok', finalUrl: 'https://x.example/p', httpStatusCode: 200 },
  ok403: { kind: 'ok', finalUrl: 'https://scholar.google.com/scholar?q=x', httpStatusCode: 403 },
  ok_same_document: { kind: 'ok_same_document', finalUrl: 'https://x.example/p#sec2' },
  failed: { kind: 'failed', errorCode: -105, errorDesc: 'ERR_NAME_NOT_RESOLVED' },
  crashed: { kind: 'crashed', reason: 'oom' },
  download: { kind: 'download', url: 'https://x/f.pdf', mimeType: 'application/pdf', filename: '2210.02747.pdf', cancelled: 'policy' },
  blocked: { kind: 'blocked', reason: '不允许访问本机与内网地址：10.0.0.5' },
  superseded: { kind: 'superseded' },
  cancelled: { kind: 'cancelled' },
  timeout: { kind: 'timeout', abortObserved: false },
  timeoutAborted: { kind: 'timeout', abortObserved: true },
} as const satisfies Record<string, Outcome>;

const ALL_KINDS: Outcome['kind'][] = [
  'ok', 'ok_same_document', 'failed', 'crashed', 'download', 'blocked', 'superseded', 'cancelled', 'timeout',
];

/**
 * 「这个源不行、换一个」这类**断言句**。
 *
 * 「」里的提及不算断言 —— timeout 那条正是在说「这与『打不开』不是一回事」，
 * 先把引号里的内容去掉再判，判的才是这句话有没有把它**说成**失败。
 */
const stripQuoted = (s: string): string => s.replace(/「[^」]*」/g, '');
const CLAIMS_SOURCE_DEAD = /打不开|源不可用|源不可达|换一个源|换个源|换源/;

describe('导航结果文案：只有 failed 才能把它说成「打不开」', () => {
  // 评审者的变异：把 superseded 的文案换成「打不开：这个源不可用，换一个源再试。」
  // → 45 条全绿。被接替的导航被说成源不可用，agent 就会去换源，而源好好的。
  // blocked（我们自己挡的）、cancelled（标签被关了）、crashed（进程崩了）
  // 、timeout（不知道发生了什么）同理 —— 这几种我们都明确知道发生了什么。
  const mustNotBlameSource = ['ok', 'ok_same_document', 'crashed', 'download', 'blocked', 'superseded', 'cancelled', 'timeout'] as const;
  for (const kind of mustNotBlameSource) {
    it(`${kind} 的文案不把结论说成「这个源不可用」`, () => {
      const s = stripQuoted(say(SAMPLES[kind]));
      expect(s).not.toMatch(CLAIMS_SOURCE_DEAD);
    });
  }

  it('failed 是唯一一个明说打不开的 —— 它确实是网络层的明确拒绝', () => {
    const s = say(SAMPLES.failed);
    expect(s).toMatch(/打不开/);
    expect(s).toContain('ERR_NAME_NOT_RESOLVED');
    expect(s).toContain('-105');
  });
});

describe('导航结果文案：每条都带上自己那个终态的协议事实', () => {
  // 带上各自的事实，等于让「拿一句通用的失败文案顶替」这种改法必然红。
  it('ok 带最终地址与状态码', () => {
    expect(say(SAMPLES.ok)).toContain('https://x.example/p');
    expect(say(SAMPLES.ok)).toContain('200');
  });

  // 403 是一次**成功**的导航：页面到了，只是内容多半是拦截页。说清状态码，
  // 让 skill 的换源规则有协议层依据，而不是去猜页面文案。
  it('403 说清「页面到了」而不是「打不开」', () => {
    const s = say(SAMPLES.ok403);
    expect(s).toContain('403');
    expect(stripQuoted(s)).not.toMatch(CLAIMS_SOURCE_DEAD);
  });

  // 跨文档 DOM 全换、快照身份要重发号；同文档 DOM 大体还在。下游快照 diff 要
  // 这个区别，文案里也必须说得出来，不能与跨文档那条撞成一句话。
  it('ok_same_document 说明文档没换、没有新的 HTTP 响应', () => {
    const s = say(SAMPLES.ok_same_document);
    expect(s).toContain('https://x.example/p#sec2');
    expect(s).toMatch(/同一个文档|同文档/);
    expect(s).toMatch(/没有新的 HTTP 响应|没有整体换/);
  });

  it('crashed 带上崩溃原因，并说明这不是网络层的拒绝', () => {
    const s = say(SAMPLES.crashed);
    expect(s).toContain('oom');
    expect(s).toMatch(/崩溃/);
    expect(s).toMatch(/重开|再试一次|重试/);
  });

  it('download 带上文件类型与文件名，并说明这不是网页', () => {
    const s = say(SAMPLES.download);
    expect(s).toContain('application/pdf');
    expect(s).toContain('2210.02747.pdf');
    expect(s).toMatch(/不是网页/);
  });

  // 变异「把 blocked 换成一句通用的失败文案」→ 闸给的理由就没了。理由是模型判断
  // 「该换一个公网地址」还是「该换源」的唯一依据。
  it('blocked 带上闸给的理由，并说清是我们这一侧挡的', () => {
    const s = say(SAMPLES.blocked);
    expect(s).toContain('不允许访问本机与内网地址：10.0.0.5');
    expect(s).toMatch(/KyDog|我们这一侧|网址闸/);
  });

  it('superseded 说的是「被另一次导航接替」，不是失败', () => {
    const s = say(SAMPLES.superseded);
    expect(s).toMatch(/接替|取代/);
    expect(s).toMatch(/本次没有结果|没有结果/);
  });

  // 接线清单第 8 项：onSuperseded 只在 navigate() 里换 tracker 之前调。页面自己
  // 跳走走的是 did-navigate、收敛到 ok，永远到不了这条文案 —— 写进去只会让模型
  // 把两件事混在一起推断页面状态。
  it('superseded 不提「页面自己跳走了」—— 那条路根本到不了这里', () => {
    expect(say(SAMPLES.superseded)).not.toContain('页面自己跳走');
  });

  it('cancelled 说的是标签被关掉了，不是源的问题', () => {
    const s = say(SAMPLES.cancelled);
    expect(s).toMatch(/标签/);
    expect(s).toMatch(/关掉|关闭|回收/);
  });

  it('timeout 明说我们不知道发生了什么', () => {
    const s = say(SAMPLES.timeout);
    expect(s).toMatch(/不知道发生了什么/);
  });

  // 观测到的 ERR_ABORTED 是协议事实，收尾时要如实带上，不能丢掉；
  // 没观测到就不许凭空说有。
  it('timeout 把观测到的 ERR_ABORTED 如实说出来，没观测到就不说', () => {
    expect(say(SAMPLES.timeoutAborted)).toContain('ERR_ABORTED');
    expect(say(SAMPLES.timeout)).not.toContain('ERR_ABORTED');
  });
});

describe('导航结果文案：每个终态各说各的', () => {
  // 模型对这几种的处置各不相同（重开 / 换公网地址 / 重新看一眼 / 重开标签 /
  // 别断定源不可用）。两条文案撞成一句，模型就分不出该做哪件事。
  it('九个终态的文案两两不同', () => {
    const texts = ALL_KINDS.map((k) => say(k === 'timeout' ? SAMPLES.timeout : SAMPLES[k as Exclude<typeof k, 'timeout'>]));
    expect(new Set(texts).size).toBe(ALL_KINDS.length);
  });

  it('每个终态都给得出一句非空文案', () => {
    for (const k of ALL_KINDS) {
      const s = say(k === 'timeout' ? SAMPLES.timeout : SAMPLES[k as Exclude<typeof k, 'timeout'>]);
      expect(s.length).toBeGreaterThan(0);
    }
  });
});

describe('取不取快照：ok_same_document 也是「到了一个页面」', () => {
  // browser_open 从前判的是 `kind === 'ok'`，同文档导航（SPA 路由、CNKI 站内）
  // 成功了却拿不到新快照：模型收到「跳转成功」外加零内容，只能再空跑一轮拿 diff。
  it('两种成功都要取快照', () => {
    expect(landedOnPage(SAMPLES.ok)).toBe(true);
    expect(landedOnPage(SAMPLES.ok403)).toBe(true);
    expect(landedOnPage(SAMPLES.ok_same_document)).toBe(true);
  });

  // 拿不到内容的时候硬取只会给一份空快照，让模型以为「这个页面什么都没有」，
  // 而事实是它压根没打开。
  it('其余终态一律不取', () => {
    for (const k of ['failed', 'crashed', 'download', 'blocked', 'superseded', 'cancelled', 'timeout'] as const) {
      expect(landedOnPage(SAMPLES[k])).toBe(false);
    }
  });
});

// spec §5.5：上限要落在 **TypeBox schema** 上，模型绕不过去。schema 这一层没有任何
// 别的东西会在退化时报错 —— 改回 Type.String() / Type.Number() 编译照样过，单测也照样
// 全绿，而模型第一眼看到的契约就此松掉。
describe('browser_act 的 schema 是模型看得到的那道闸', () => {
  const props = (ActionSchema as unknown as { properties: Record<string, Record<string, unknown>> }).properties;

  it('kind 是九种动作的字面量白名单，不是裸字符串', () => {
    const kind = props.kind as { anyOf?: { const: string }[]; type?: string };
    expect(kind.type).toBeUndefined();
    expect(kind.anyOf?.map((x) => x.const)).toEqual([...ACTION_KINDS]);
  });

  it('timeoutMs 带上下界与默认值，与主进程校验同一组数', () => {
    expect(props.timeoutMs).toMatchObject({
      type: 'number', minimum: 1, maximum: WAIT_MAX_MS, default: WAIT_DEFAULT_MS,
    });
  });

  // 与 kind 同一个道理：裸字符串的话 `{kind:'scroll', direction:'left'}` 连 schema
  // 都过得去，模型要等到主进程校验才知道没有这个方向。
  it('direction 是 up / down 的字面量白名单', () => {
    const d = props.direction as { anyOf?: { const: string }[]; type?: string };
    expect(d.type).toBeUndefined();
    expect(d.anyOf?.map((x) => x.const)).toEqual(['up', 'down']);
  });

  // 这一份 schema 九种动作共用，所以除了 kind **一个都不能是必填** ——
  // direction 写成必填的话，click / type / key 每一个都要凑一个方向出来才过得了 schema。
  it('九种动作共用一份参数对象，所以只有 kind 是必填', () => {
    const required = (ActionSchema as unknown as { required?: string[] }).required ?? [];
    expect(required).toEqual(['kind']);
  });

  // amount 不进 schema 的话，`Action` 类型上那个 `amount?` 模型根本用不到 ——
  // 声明了一个谁都调不动的参数。
  it('scroll 的 amount 在 schema 上，带下界', () => {
    expect(props.amount).toMatchObject({ type: 'number', minimum: 1 });
  });
});

// ── 接线层：browser_act / browser_read 的 execute 真的跑一遍 ──────────────────
//
// **这一段补的是最终评审的 C4。** 在它之前，这个文件只覆盖 describeNav / landedOnPage
// / TypeBox schema 三样纯文本的东西，**没有任何一条用例调用过 createBrowserTools 返回
// 的工具**。评审的 13 次变异里 11 条死在各批自己的纯模块里，2 条活的全部落在这里：
//
//  · M12 —— 删掉 `assertTypeAllowed` 的唯一调用点 → 2336/2336 全绿（密码硬闸整条失效）
//  · M13 —— extract 退回主世界 + 绕过整批预算 → 2336/2336 全绿、lint exit 0 无警告
//
// 所以下面这些断言全部针对**接线**，不重复各批纯模块自己已经钉住的东西。
// 隔离世界这一条在替身里只能钉住「调的是哪个入口」；「隔离世界真的骗不到」要靠
// e2e（见 e2e-requirements.md 的 E-1）。

const WORLD_ID = 31337;

const bs = vi.hoisted(() => ({
  /** enqueue / withAgentDriving / snapshot / 每一步派发的实际先后。 */
  order: [] as string[],
  isolated: [] as { worldId: number; code: string }[],
  mainWorld: [] as string[],
  cdp: [] as { method: string; params: unknown }[],
  current: null as unknown,
  /** 隔离世界里那段代码的返回值由用例摆布（extract / browser_read 共用）。 */
  isolatedImpl: (() => null) as (code: string) => unknown,
  snapshotImpl: (() => null) as () => unknown,
  noTab: false,
  /** `evalInPage` 抛什么（没有渲染进程 / 撞时限）。null 就是照常求值。 */
  evalThrows: null as Error | null,
  /** 每一次 dispatch 收到的东西（动作原样、以及当时传进去的快照）。 */
  dispatched: [] as { tabId: string; action: { kind: string }; snapshot: unknown }[],
  dispatchImpl: ((a: { kind: string }) => `派发了 ${a.kind}`) as (a: { kind: string }) => string,
  waits: [] as { tabId: string; until: unknown; timeoutMs: number }[],
  waitImpl: (() => true) as () => boolean,
  /** 标签清单可变 —— 一批动作中途 target=_blank 会开出新标签。 */
  tabs: [] as { id: string; url: string }[],
  navImpl: (() => ({ navigationId: 'n1', outcome: { kind: 'ok', finalUrl: 'https://a.example/q', httpStatusCode: 200 } })) as () => unknown,
}));

vi.mock('../browser/browserService', () => {
  const wc = {
    executeJavaScript: (code: string) => { bs.mainWorld.push(code); return Promise.resolve('主世界'); },
    executeJavaScriptInIsolatedWorld: (worldId: number, scripts: { code: string }[]) => {
      bs.isolated.push({ worldId, code: scripts[0].code });
      return Promise.resolve(bs.isolatedImpl(scripts[0].code));
    },
    debugger: {
      sendCommand: (method: string, params: unknown) => { bs.cdp.push({ method, params }); return Promise.resolve(); },
    },
  };
  return {
    WALKER_WORLD_ID: 31337,
    browserService: {
      getState: () => ({ tabs: bs.tabs, activeTabId: 't1' }),
      getSnapshot: () => { bs.order.push('getSnapshot'); return bs.current; },
      snapshot: async () => { bs.order.push('snapshot'); return bs.snapshotImpl(); },
      webContentsOf: () => { bs.order.push('webContentsOf'); return bs.noTab ? null : wc; },
      /**
       * 两道保护齐全的页内求值入口（没有渲染进程就不注入 + 罩时限）。
       * 工具层拿 `webContentsOf()` 自己注脚本的那条路**必须没有调用方**：
       * 崩过一次的标签上那是一次挂死，而 browser_read / browser_act 都是
       * sequential 工具 —— 挂住就是整轮 run 永远不返回。
       */
      evalInPage: (_tabId: string, code: string) => {
        bs.order.push('evalInPage');
        if (bs.evalThrows) return Promise.reject(bs.evalThrows);
        bs.isolated.push({ worldId: 31337, code });
        return Promise.resolve(bs.isolatedImpl(code));
      },
      dispatch: (tabId: string, action: { kind: string }, snapshot: unknown) => {
        bs.order.push(`dispatch:${action.kind}`);
        bs.dispatched.push({ tabId, action, snapshot });
        return Promise.resolve(bs.dispatchImpl(action));
      },
      waitFor: (tabId: string, until: unknown, timeoutMs: number) => {
        bs.order.push('waitFor');
        bs.waits.push({ tabId, until, timeoutMs });
        return Promise.resolve(bs.waitImpl());
      },
      open: (args: { url: string }) => {
        bs.order.push(`open:${args.url}`);
        return Promise.resolve({ tabId: 't1', nav: bs.navImpl() });
      },
      enqueue: <T>(tabId: string, fn: () => Promise<T>) => { bs.order.push(`enqueue:${tabId}`); return fn(); },
      withAgentDriving: <T>(tabId: string, runId: string | null, fn: () => Promise<T>) => {
        bs.order.push(`driving:${tabId}:${runId}`); return fn();
      },
    },
  };
});

const snap = (over: Record<string, unknown> = {}) => ({
  snapshotId: 'snap_aaa', generation: 'gen-1', url: 'https://a.example/q', title: '结果页',
  nodes: [], collection: { truncated: false, returned: 0, totalKnown: 0 }, iframes: 0, ...over,
});
const node = (over: Record<string, unknown> = {}) => ({
  index: 1, nodeId: 7, role: 'textbox', name: '检索框', x: 10, y: 20, w: 200, h: 30, ...over,
});

type Exec = (id: string, params: unknown, signal?: AbortSignal) => Promise<{ content: { text?: string }[]; details?: unknown }>;
const toolNamed = (name: string): { execute: Exec; description: string } =>
  createBrowserTools({ currentRunId: () => 'run-1' })
    .find((t) => t.name === name) as unknown as { execute: Exec; description: string };

const bodyOf = (r: { content: { text?: string }[] }): string => r.content.map((c) => c.text ?? '').join('\n');

const act = (actions: unknown[], signal?: AbortSignal) =>
  toolNamed('browser_act').execute('call-1', { tabId: 't1', actions }, signal);

beforeEach(() => {
  bs.order.length = 0; bs.isolated.length = 0; bs.mainWorld.length = 0; bs.cdp.length = 0;
  bs.dispatched.length = 0; bs.waits.length = 0;
  bs.current = snap();
  bs.snapshotImpl = () => snap({ snapshotId: 'snap_bbb' });
  bs.isolatedImpl = () => null;
  bs.dispatchImpl = (a) => `派发了 ${a.kind}`;
  bs.waitImpl = () => true;
  bs.tabs = [{ id: 't1', url: 'https://a.example/q' }];
  bs.noTab = false;
  bs.evalThrows = null;
});

describe('六种动作真的接通到 browserService.dispatch（Task 4）', () => {
  // 这一批之前 click / type / hover / select / scroll / wait 一律抛「这个动作还没有
  // 实现」。**接通之后最要紧的不是「能跑」，是「跑的是 dispatch 那条路」** ——
  // 三件事（滚进视野 / 重新量坐标 / 命中检查）与两道闸（渲染进程、密码）全在那里，
  // 谁在工具层另开一条 `wc.debugger.sendCommand` 的近路，那六样一件都不会发生，
  // 而返回值照样读起来是「做过了」。
  const six = [
    ['click', { kind: 'click', index: 1, snapshotId: 'snap_aaa' }],
    ['hover', { kind: 'hover', index: 1, snapshotId: 'snap_aaa' }],
    ['type', { kind: 'type', index: 1, snapshotId: 'snap_aaa', text: '量子计算' }],
    ['select', { kind: 'select', index: 1, snapshotId: 'snap_aaa', value: '2024' }],
    ['scroll', { kind: 'scroll', direction: 'down' }],
    ['key', { kind: 'key', key: 'Enter' }],
  ] as const;

  for (const [kind, action] of six) {
    it(`${kind} 走 dispatch，并把它说的那句话原样交给模型`, async () => {
      bs.current = snap({ nodes: [node()] });
      bs.dispatchImpl = () => `【${kind} 的真实结果】`;
      const s = bodyOf(await act([action]));
      expect(bs.dispatched.map((d) => d.action.kind)).toEqual([kind]);
      expect(bs.dispatched[0].tabId).toBe('t1');
      expect(s).toContain(`【${kind} 的真实结果】`);
      expect(s).not.toContain('⚠');
      // 派发一条都不许绕过 dispatch 直接发 CDP。
      expect(bs.cdp).toEqual([]);
    });
  }

  // dispatch 要在**当前**快照里解析 index。传 null 或传一份别的，编号会解析到
  // 另一个元素上 —— 不报错，只是点错东西。
  it('当前快照原样传给 dispatch —— index 只在那一份里解析', async () => {
    const cur = snap({ snapshotId: 'snap_now', nodes: [node()] });
    bs.current = cur;
    await act([{ kind: 'click', index: 1, snapshotId: 'snap_now' }]);
    expect(bs.dispatched[0].snapshot).toBe(cur);
  });

  it('dispatch 抛错：整批停在那里，前面几步的结果照常返回', async () => {
    bs.current = snap({ nodes: [node()] });
    let n = 0;
    bs.dispatchImpl = (a) => {
      if (++n === 2) throw new KydogError('browser.click_intercepted', '被 div.cookie-banner 挡住了');
      return `做了 ${a.kind}`;
    };
    const s = bodyOf(await act([
      { kind: 'key', key: 'Enter' },
      { kind: 'click', selector: '.next' },
      { kind: 'key', key: 'Tab' },
    ]));
    expect(s).toContain('做了 key');
    expect(s).toContain('⚠');
    expect(s).toContain('被 div.cookie-banner 挡住了');
    expect(bs.dispatched.length).toBe(2);            // 第三步没有执行
  });

  it('extract 不走 dispatch —— 它要整批预算，跑在工具层', async () => {
    bs.isolatedImpl = () => ({
      rows: [{ t: 'x' }], rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
      fieldTruncation: { truncated: false, limit: 1000, columns: [] },
    });
    await act([{ kind: 'extract', selectors: { item: '.r', t: 'h3' } }]);
    expect(bs.dispatched).toEqual([]);
  });
});

describe('wait 走 waitFor：超时是「条件未达成」，不是「这个源不行」', () => {
  it('until 解析之后交给 waitFor，默认时限是 WAIT_DEFAULT_MS', async () => {
    const s = bodyOf(await act([{ kind: 'wait', until: { selector: '.result' } }]));
    expect(bs.waits).toEqual([{ tabId: 't1', until: { selector: '.result', state: 'present' }, timeoutMs: WAIT_DEFAULT_MS }]);
    expect(s).not.toContain('⚠');
    // 等的是哪一件事要说准：把「出现」说成「消失」，模型据此推断的页面状态整个是反的。
    expect(s).toContain('.result');
    expect(s).toContain('出现');
    expect(s).not.toContain('消失');
  });

  it('state=absent 的那句话说的是「消失」', async () => {
    const s = bodyOf(await act([{ kind: 'wait', until: { selector: '.loading', state: 'absent' } }]));
    expect(s).toContain('消失');
    expect(s).not.toContain('出现');
  });

  it('模型给的 timeoutMs 原样传下去', async () => {
    await act([{ kind: 'wait', until: { urlMatches: '/search' }, timeoutMs: 3000 }]);
    expect(bs.waits[0]).toMatchObject({ until: { urlMatches: '/search' }, timeoutMs: 3000 });
  });

  // spec §4.2：「超时只表示条件未达成，不表示别的；它是一个动作失败，按出错即停处理」。
  it('条件没达成 → 整批停下，并说清这只是条件没成立', async () => {
    bs.waitImpl = () => false;
    const s = bodyOf(await act([
      { kind: 'wait', until: { selector: '.result' }, timeoutMs: 2000 },
      { kind: 'key', key: 'Enter' },
    ]));
    expect(s).toContain('⚠');
    expect(s).toContain('2000');
    expect(s).toContain('.result');
    // 说成「打不开 / 换个源」的话，模型会去换一个好好的源。
    expect(s).not.toMatch(/打不开|源不可用|换源|换一个源/);
    expect(bs.dispatched).toEqual([]);               // 后面那一步没有执行
  });

  // until 形态不合在**整批跑起来之前**就要拒（validateBatch 那一层），
  // 不能等到轮询时才发现。
  it('until 形态不合 → 根本不进队列', async () => {
    await expect(act([{ kind: 'wait', until: {} }])).rejects.toThrow(/wait.until/);
    expect(bs.order).toEqual([]);
  });
});

describe('这一批里新开的标签必须列出来（spec §5.1）', () => {
  // 不列的话：模型点了一下、返回值说「成功」，而内容出现在一个它不知道存在的标签里，
  // 接下来它会对着旧标签继续操作 —— 一整轮检索都在一个没变的页面上跑。
  it('动作中途开出来的标签，结果里点名带上 id 与地址', async () => {
    bs.dispatchImpl = (a) => {
      bs.tabs.push({ id: 'tab_new1', url: 'https://publisher.example/article/42' });
      return `做了 ${a.kind}`;
    };
    const s = bodyOf(await act([{ kind: 'click', selector: 'a[target=_blank]' }]));
    expect(s).toContain('tab_new1');
    expect(s).toContain('https://publisher.example/article/42');
    expect(s).toMatch(/新开|新标签/);
  });

  it('没开新标签就一个字都不提 —— 不许有假阳性', async () => {
    const s = bodyOf(await act([{ kind: 'key', key: 'Enter' }]));
    expect(s).not.toMatch(/新开|新标签/);
  });
});

describe('密码硬闸在工具层这一侧的样子', () => {
  // 闸本体与它的两道调用点都搬进了 `browserService.dispatch`（真正拿得到活元素的
  // 那一层），由 browserService.test.ts 的两条用例守着：
  // 「快照说它是密码框 → 一条 CDP 都不发」与「selector 定位的密码框 → 第二道在页面里拦」。
  // 工具层这一侧要守的是**别把它咽掉**：报出来，而且模型给的那串文本一个字都不回显。
  it('dispatch 报密码闸时，整批停下并如实转达', async () => {
    bs.current = snap({ nodes: [node({ isPassword: true, name: '密码' })] });
    bs.dispatchImpl = () => {
      throw new KydogError('browser.password_field',
        '不能往密码框里输入。机构登录用 browser_login（由主进程填），其他登录请交给用户');
    };
    const s = bodyOf(await act([{ kind: 'type', index: 1, snapshotId: 'snap_aaa', text: 'hunter2' }]));
    expect(s).toContain('不能往密码框里输入');
    expect(s).toContain('browser_login');
    expect(s).toContain('⚠');
  });

  it('那一批里模型给的文本一个字都不回显', async () => {
    bs.current = snap({ nodes: [node({ isPassword: true })] });
    bs.dispatchImpl = () => { throw new KydogError('browser.password_field', '不能往密码框里输入。'); };
    const r = await act([{ kind: 'type', index: 1, snapshotId: 'snap_aaa', text: 'hunter2' }]);
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  // 工具描述是模型第一眼看到的契约。六种动作接通之后，那句「当前版本只接通了 key 与
  // extract」必须跟着删 —— 留着它模型会绕开 click / type 去想别的办法。
  it('工具描述不再说任何动作没实现', () => {
    const d = toolNamed('browser_act').description;
    expect(d).not.toMatch(/还没有实现|还没实现|只接通/);
    expect(d).toContain('click');
    expect(d).toContain('type');
  });

  // 「type 会先清空目标框」这句话对 date / time / month / week / datetime-local
  // **是假的**（实测：insertText 对分段选择器完全无效，先清空反而把原值抹了）。
  // 描述是模型唯一读得到的契约，说了做不到的事，模型就会照着排剧本。
  it('描述里「先清空」这句话必须把做不到的那一类说清楚', () => {
    const d = toolNamed('browser_act').description;
    expect(d).toContain('先清空');
    expect(d).toMatch(/date|日期/);
  });
});

describe('extract 的接线：隔离世界 + 整批预算（评审变异 M13）', () => {
  const rowsOf = (n: number, chars: number) => ({
    rows: Array.from({ length: n }, (_, i) => ({ t: `${i}`.padEnd(chars, 'x') })),
    rowTruncation: { truncated: false, returned: n, totalKnown: n },
    fieldTruncation: { truncated: false, limit: 1000, columns: [] },
  });

  // 把 executeJavaScriptInIsolatedWorld(WALKER_WORLD_ID, …) 改回 wc.executeJavaScript(…)
  // → 评审实测三条 gate 零信号。替身这一层钉得住「调的是哪个入口、世界 id 是哪个」；
  // 「隔离世界真的骗不到页面覆写」要靠 e2e（E-1 第一条断言）。
  it('抽取走隔离世界，世界 id 就是 walker 那个，主世界一次都不碰', async () => {
    bs.isolatedImpl = () => rowsOf(1, 10);
    await act([{ kind: 'extract', selectors: { item: '.r', t: 'h3' } }]);
    expect(bs.isolated.length).toBe(1);
    expect(bs.isolated[0].worldId).toBe(WORLD_ID);
    expect(bs.mainWorld).toEqual([]);
  });

  // M13 的另一半：把 `budget.admit(res.rows, collected)` 换成 `collected.push(...res.rows)`
  // → 一样零信号。E-1 原来的断言写法（覆写 querySelectorAll 看抽到真结构还是伪造结构）
  // 拦不住这一条，所以它必须在这里守住。
  it('整批预算跨步骤累计，超了要如实回报而不是照单全收', async () => {
    // 每步 40 行 × 约 1000 字符 ≈ 4 万字符，两步就超过 MAX_BATCH_CHARS。
    bs.isolatedImpl = () => rowsOf(40, 1000);
    const s = bodyOf(await act([
      { kind: 'extract', selectors: { item: '.r', t: 'h3' } },
      { kind: 'extract', selectors: { item: '.r', t: 'h3' } },
    ]));
    expect(s).toContain(`累计超过整批 ${MAX_BATCH_CHARS} 字符的预算`);
    expect(s).toContain('这是截断，不是「只抽到这么多」');
    // 「共抽到 80 条 / 收下的少于 80」这两个数都要是真的。
    expect(s).toContain('共抽到 80 条');
    const kept = Number(/抽到 (\d+) 条（这一批/.exec(s)![1]);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(80);
  });

  it('没超预算时一个字都不提预算 —— 截断回报不许有假阳性', async () => {
    bs.isolatedImpl = () => rowsOf(2, 10);
    const s = bodyOf(await act([{ kind: 'extract', selectors: { item: '.r', t: 'h3' } }]));
    expect(s).toContain('抽到 2 条：');
    expect(s).not.toContain('预算');
  });
});

describe('browser_act 的整批走 enqueue + withAgentDriving（I1）', () => {
  // browserService.ts 的两处 docblock 逐字写着这两个「公开是给 Task 4 的……不要另开
  // 一条路」。不走的后果：(a) 整批期间 isAgentActive 恒为 false → 动作触发的
  // window.open 新标签被判成用户的 → disposeForRun 永不回收；(b) 与渲染层的
  // browser.navControl / browser.open 在同一标签上不串行。
  it('排队与驱动窗口都套在整批外面，派发与收尾快照都在里面', async () => {
    bs.isolatedImpl = () => ({
      rows: [], rowTruncation: { truncated: false, returned: 0, totalKnown: 0 },
      fieldTruncation: { truncated: false, limit: 1000, columns: [] },
    });
    await act([{ kind: 'extract', selectors: { item: '.r', t: 'h3' } }]);
    // `getSnapshot` 是取 `before` 那一份：**它也必须在队列里面**（最终复评 m4）。
    // 取在队列外的话，这一批在队列里等的那段时间同一个标签上别人产生的新快照
    // 会被算进「本批的页面变化」。
    expect(bs.order).toEqual(['enqueue:t1', 'driving:t1:run-1', 'getSnapshot', 'evalInPage', 'snapshot']);
  });

  it('browser_read 也走同一条路', async () => {
    bs.isolatedImpl = () => '正文';
    await toolNamed('browser_read').execute('call-2', { tabId: 't1' });
    expect(bs.order).toEqual(['enqueue:t1', 'driving:t1:run-1', 'evalInPage']);
  });

  // 形状不对的一批不该先去占住这个标签的队列。
  it('批次校验在排队之前 —— 不认识的动作根本进不了队列', async () => {
    await expect(act([{ kind: 'navigate', url: 'https://evil.example/' }])).rejects.toThrow(/不认识的动作/);
    expect(bs.order).toEqual([]);
  });
});

describe('browser_read 走隔离世界（I3）', () => {
  // 与 extract 当初搬进隔离世界的理由一字不差：页面覆写 document.querySelector /
  // innerText 骗得到主世界。整页正文同样是模型当事实用的东西。
  it('读正文用的是隔离世界，不是主世界', async () => {
    bs.isolatedImpl = () => '正文';
    const s = bodyOf(await toolNamed('browser_read').execute('call-2', { tabId: 't1' }));
    expect(bs.mainWorld).toEqual([]);
    expect(bs.isolated.map((r) => r.worldId)).toEqual([WORLD_ID]);
    expect(s).toContain('正文');
  });
});

// ── 页内求值必须走带闸的那个入口（C1）──────────────────────────────────────
//
// 实测：渲染进程崩过一次之后 `getOSProcessId()` 回 0，而 `isAttached()` 仍是 true、
// `isDestroyed()` 是 false —— `webContentsOf()` 照常回一个非 null 的 wc，
// 而在它上面求值**永不 settle**（3 秒内无任何结果）。browser_read 与 extract
// 都在 sequential 工具里，挂住就是整轮 run 永远不返回，`signal` 也救不回来
// （它只在步骤之间查）。所以这两条路都不许自己拿 wc 注脚本。
describe('页内求值走 evalInPage，不自己拿 webContents 注脚本', () => {
  it('browser_read 不碰 webContentsOf，走的是带闸的入口', async () => {
    bs.isolatedImpl = () => '正文';
    await toolNamed('browser_read').execute('c', { tabId: 't1' });
    expect(bs.order).toContain('evalInPage');
    expect(bs.order).not.toContain('webContentsOf');
  });

  it('extract 不碰 webContentsOf，走的是带闸的入口', async () => {
    bs.isolatedImpl = () => ({
      rows: [{ t: '一篇论文' }],
      rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
      fieldTruncation: { truncated: false, limit: 1000, columns: [] },
    });
    await act([{ kind: 'extract', selectors: { item: '.r', t: 'h3' } }]);
    expect(bs.order).toContain('evalInPage');
    expect(bs.order).not.toContain('webContentsOf');
  });

  it('标签没有渲染进程时 browser_read 当场报错，不挂住', async () => {
    bs.evalThrows = new KydogError('browser.not_dispatchable', '标签 t1 还没有渲染进程');
    await expect(toolNamed('browser_read').execute('c', { tabId: 't1' }))
      .rejects.toMatchObject({ code: 'browser.not_dispatchable' });
  });

  // 一批里前面几步抽到的东西不该跟着这一条一起丢 —— 与「出错即停但已抽到的数据
  // 全部返回」是同一条承诺。
  it('extract 撞上求值失败：这一批停在那里，前面抽到的照常返回', async () => {
    let n = 0;
    bs.isolatedImpl = () => {
      if (++n === 2) throw new KydogError('browser.page_no_result', '页面没有回应这次求值');
      return {
        rows: [{ t: '第一步抽到的' }],
        rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
        fieldTruncation: { truncated: false, limit: 1000, columns: [] },
      };
    };
    const s = bodyOf(await act([
      { kind: 'extract', selectors: { item: '.r', t: 'h3' } },
      { kind: 'extract', selectors: { item: '.r', t: 'h3' } },
    ]));
    expect(s).toContain('第一步抽到的');
    expect(s).toContain('页面没有回应这次求值');
  });
});

describe('收尾快照抛了也要把已经抽到的数据交出来（I2）', () => {
  // 标签在这一刻已经没了（用户关了侧栏那个标签、或 disposeForRun 抢在前面）就抛
  // browser.no_tab。快照在 try 之外的时候，这一批**已经抽到的数据全部跟着丢掉** ——
  // 与 ACT_DESC 承诺的「出错即停但已抽到的数据全部返回」正好相反。
  it('抽到的数据照常返回，并说清页面此刻什么样这次说不出来', async () => {
    bs.isolatedImpl = () => ({
      rows: [{ t: '一篇论文' }],
      rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
      fieldTruncation: { truncated: false, limit: 1000, columns: [] },
    });
    bs.snapshotImpl = () => { throw new KydogError('browser.no_tab', '没有这个标签页：t1'); };
    const r = await act([{ kind: 'extract', selectors: { item: '.r', t: 'h3' } }]);
    const s = bodyOf(r);
    expect(s).toContain('一篇论文');
    expect(s).toContain('抽到 1 条');
    expect(s).toContain('取不到收尾快照');
    // 「我没取到」与「页面没有变化」绝不许长得一样。
    expect(s).not.toContain('页面没有变化');
    expect((r.details as { snapshotId: string | null }).snapshotId).toBeNull();
  });
});

describe('错的 tabId 不许先去占住队列（最终复评 m3）', () => {
  // `enqueue` 无条件 `queues.set(tabId, …)`，而清理只在真标签的回收路径上 ——
  // 模型手滑写错一个 tabId 每次留一个永不删除的条目。那行注释立的规矩是
  // 「只增不减」不许发生。
  it('browser_act：不存在的标签当场报 no_tab，一次 enqueue 都不发生', async () => {
    await expect(toolNamed('browser_act').execute('c', { tabId: 't_typo', actions: [{ kind: 'key', key: 'Enter' }] }))
      .rejects.toMatchObject({ code: 'browser.no_tab' });
    expect(bs.order).toEqual([]);
  });

  it('browser_read 同样', async () => {
    await expect(toolNamed('browser_read').execute('c', { tabId: 't_typo' }))
      .rejects.toMatchObject({ code: 'browser.no_tab' });
    expect(bs.order).toEqual([]);
  });

  it('真的存在的标签照常进队列 —— 上面两条不是空绿', async () => {
    await act([{ kind: 'key', key: 'Enter' }]);
    expect(bs.order[0]).toBe('enqueue:t1');
  });
});

describe('browser_open 的收尾快照抛了，导航结论不许跟着一起丢（最终复评登记项）', () => {
  // 与 browser_act 的 I2 是同一个失败形状：标签在这一刻已经没了就抛 browser.no_tab，
  // 把**已经拿到的导航结论**一起丢光 —— 而 describeNav 那句话（尤其 timeout /
  // superseded / blocked 几条）是模型唯一读得到的协议事实。
  it('快照失败时，导航那句话照常返回，并说清这是「没看到」', async () => {
    bs.snapshotImpl = () => { throw new KydogError('browser.no_tab', '没有这个标签页：t1'); };
    const s = bodyOf(await toolNamed('browser_open').execute('c', { url: 'https://a.example/q' }));
    expect(s).toContain('https://a.example/q');
    expect(s).toContain('取不到页面快照');
    expect(s).toContain('没看到');
  });

  it('快照正常时照常带快照 —— 上一条不是空绿', async () => {
    bs.snapshotImpl = () => snap({ snapshotId: 'snap_open', title: '结果页' });
    const s = bodyOf(await toolNamed('browser_open').execute('c', { url: 'https://a.example/q' }));
    expect(s).toContain('snap_open');
    expect(s).not.toContain('取不到页面快照');
  });
});
