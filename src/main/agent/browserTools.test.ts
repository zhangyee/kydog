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
      getState: () => ({ tabs: [{ id: 't1', url: 'https://a.example/q' }], activeTabId: 't1' }),
      getSnapshot: () => bs.current,
      snapshot: async () => { bs.order.push('snapshot'); return bs.snapshotImpl(); },
      webContentsOf: () => (bs.noTab ? null : wc),
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
  bs.current = snap();
  bs.snapshotImpl = () => snap({ snapshotId: 'snap_bbb' });
  bs.isolatedImpl = () => null;
  bs.noTab = false;
});

describe('未接通的动作：显式失败，绝不以成功措辞返回（C1）', () => {
  // 计划原文写的是「browserTools.ts 先不提交 —— 动作派发是桩，Task 4 补完再一起提交」。
  // 它提前进了库，于是 click / hover / type / select 算完目标就 `return "click → #12"`：
  // 一次都没派发到页面，返回值却读起来是「做过了」。模型据此认为自己点过了，
  // 接着对一个没变的页面继续操作，或者判定这个站点的检索入口坏了并换源，全程零错误。
  const targeted = [
    ['click', { kind: 'click', index: 1, snapshotId: 'snap_aaa' }],
    ['hover', { kind: 'hover', index: 1, snapshotId: 'snap_aaa' }],
    ['type', { kind: 'type', index: 1, snapshotId: 'snap_aaa', text: '量子计算' }],
    ['select', { kind: 'select', index: 1, snapshotId: 'snap_aaa', value: '2024' }],
  ] as const;

  for (const [kind, action] of targeted) {
    it(`${kind} 报「还没有实现」并让整批停下，不回报「做过了」`, async () => {
      bs.current = snap({ nodes: [node()] });
      const s = bodyOf(await act([action]));
      expect(s).toContain('还没有实现');
      expect(s).toContain('⚠');
      // 桩的原形：`click → #7`。这个形状一旦回来，这条必红。
      expect(s).not.toMatch(new RegExp(`${kind} → #?\\d`));
      expect(s).not.toContain(`${kind} → `);
    });
  }

  // 措辞不许把「我们这一侧没做完」说成「这个源不行」—— 说错了模型就会去换源。
  it('措辞明说是 KyDog 这一侧没接通，且明说换源没有用', async () => {
    bs.current = snap({ nodes: [node()] });
    const s = bodyOf(await act([{ kind: 'click', index: 1, snapshotId: 'snap_aaa' }]));
    expect(s).toMatch(/KyDog 这一侧|我们这一侧/);
    expect(s).toContain('换源没有用');
  });

  // C2：scroll / wait 被 validateBatch 放行、needsTarget 也说它们不需要目标，
  // 而派发侧从前无条件 resolveTarget → 必抛，报的还是另一件事（「需要一个目标」）。
  // skill 教的翻页剧本会停在 wait 那一步，模型去给 wait 加 selector，永远走不出去。
  const untargeted = [
    ['scroll', { kind: 'scroll', direction: 'down' }],
    ['wait', { kind: 'wait', until: { selector: '.result' } }],
  ] as const;

  for (const [kind, action] of untargeted) {
    it(`${kind} 报的是「还没有实现」，不是那句说的是另一件事的「需要一个目标」`, async () => {
      const s = bodyOf(await act([action]));
      expect(s).toContain('还没有实现');
      expect(s).not.toContain('需要一个目标');
      expect(s).not.toContain('snapshotId');
    });
  }

  // 已经接通的两种照常跑：这条反过来钉住上面那些不是「整个工具都在抛」。
  it('key 与 extract 照常执行 —— 不是整个工具都在抛', async () => {
    bs.isolatedImpl = () => ({
      rows: [{ t: '一篇论文' }],
      rowTruncation: { truncated: false, returned: 1, totalKnown: 1 },
      fieldTruncation: { truncated: false, limit: 1000, columns: [] },
    });
    const s = bodyOf(await act([
      { kind: 'key', key: 'Enter' },
      { kind: 'extract', selectors: { item: '.r', t: 'h3' } },
    ]));
    expect(s).toContain('按下 Enter');
    expect(s).toContain('抽到 1 条');
    expect(s).not.toContain('⚠');
    expect(bs.cdp.map((c) => c.method)).toEqual(['Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
  });

  // 工具描述是模型第一眼看到的契约。派发没接通而描述照旧说「典型的检索是 click →
  // type → click」，模型只能靠撞一次错误才知道。
  it('工具描述如实说清此刻只接通了哪两种', () => {
    const d = toolNamed('browser_act').description;
    expect(d).toContain('key');
    expect(d).toContain('extract');
    expect(d).toMatch(/只接通|还没有实现|还没实现/);
  });
});

describe('密码硬闸：assertTypeAllowed 的唯一调用点（评审变异 M12）', () => {
  // 删掉 browserTools 里那一句 `if (action.kind === 'type') assertTypeAllowed(target)`
  // → 评审实测 2336/2336 全绿。actions.ts 里 assertTypeAllowed 本体有用例（M11 被杀），
  // 但**没有人守它有没有被调用**。这一组就是那道守。
  it('往密码框 type：报的是密码闸，不是「还没有实现」', async () => {
    bs.current = snap({ nodes: [node({ isPassword: true, name: '密码' })] });
    const s = bodyOf(await act([{ kind: 'type', index: 1, snapshotId: 'snap_aaa', text: 'hunter2' }]));
    expect(s).toContain('不能往密码框里输入');
    expect(s).toContain('browser_login');
    // 顺序是刻意的：密码闸排在「还没有实现」前面，放在后面它就成了死代码。
    expect(s).not.toContain('还没有实现');
  });

  // 反过来钉住上一条不是空绿：同一条路上非密码框走到的是另一句话。
  it('非密码框 type：走到的是「还没有实现」那一句', async () => {
    bs.current = snap({ nodes: [node({ isPassword: false })] });
    const s = bodyOf(await act([{ kind: 'type', index: 1, snapshotId: 'snap_aaa', text: '量子计算' }]));
    expect(s).toContain('还没有实现');
    expect(s).not.toContain('不能往密码框里输入');
  });

  it('密码框那一批里，模型给的文本一个字都不回显', async () => {
    bs.current = snap({ nodes: [node({ isPassword: true })] });
    const r = await act([{ kind: 'type', index: 1, snapshotId: 'snap_aaa', text: 'hunter2' }]);
    expect(JSON.stringify(r)).not.toContain('hunter2');
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
    expect(bs.order).toEqual(['enqueue:t1', 'driving:t1:run-1', 'snapshot']);
  });

  it('browser_read 也走同一条路', async () => {
    bs.isolatedImpl = () => '正文';
    await toolNamed('browser_read').execute('call-2', { tabId: 't1' });
    expect(bs.order).toEqual(['enqueue:t1', 'driving:t1:run-1']);
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
