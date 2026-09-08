import { describe, it, expect } from 'vitest';
import { describeNav, landedOnPage } from './browserTools';
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
