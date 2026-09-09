import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { EVENT_TOPICS, type EventTopic } from '../../shared/protocol';
import { stripComments } from '../../test-support/stripComments';

/**
 * **事件 topic 的三方对账**，照 RPC 那一套（`RPC_METHODS` / `registerHandler` /
 * `handlers.test.ts` 的穷尽性闸）。
 *
 * 要关的盲区：往 `RuntimeEvent` 加一条 topic 而**没有任何地方发它**，`tsc` 不响、
 * `lint` 不响、用例全绿 —— 渲染层照常订阅，那盏灯永远不亮。`browser.agentFocus`
 * 一度就是这个状态（Task 6 声明、Task 8 接上），本台账立起来之前它唯一的记录在一份
 * **被 .gitignore 忽略的**交接报告里。**它现在已经有发送方**（`browserService`
 * 的 `emitAgentFocus`），所以下面的 `PENDING_EMITTER` 是空的。
 *
 * 三份台账：
 *  · **声明** = `EVENT_TOPICS`（漏一条在 protocol.ts 里编译不过）；
 *  · **已接** = 下面扫出来的真实 emit 调用点；
 *  · **待接** = `PENDING_EMITTER`，每条写清楚谁来接。
 *
 * 「已接」这一份**不抄名单，去扫真实调用点** —— 手抄一份「谁在发」的清单和它要守的
 * 那件事一样容易漂，且漂了没人知道。
 */

const MAIN_DIR = path.resolve(__dirname, '..');

/**
 * 一份源码里所有「把某个字面量 topic 交出去发」的地方。三种形态是全仓仅有的三种
 * （2026-09-09 逐条核过 `broadcaster.emit(` / `emitRun(` / `topic:` 的每一处）：
 *  · `broadcaster.emit('x', …)`
 *  · `emitRun(bound, 'x', …)`        —— AgentService 的 run.* 出口，顺带进 journal
 *  · `replay({ topic: 'x', … })`     —— 只发给一个窗口的重放帧头
 * 变量形态（`broadcaster.emit(topic, payload)`，即 `emitRun` 内部那一句）扫不到，
 * 也不该扫到：那不是某一条 topic 的发送点。
 */
function emittedTopicsIn(src: string): string[] {
  const code = stripComments(src);
  const found: string[] = [];
  const patterns = [
    /\bbroadcaster\.emit\(\s*(['"`])([\w.]+)\1/g,
    /\bemitRun\(\s*[A-Za-z_$][\w$]*\s*,\s*(['"`])([\w.]+)\1/g,
    // **必须带上 `replay({`**：只写 `topic:` 的话，任何一个带 topic 字面量的对象
    // （一个类型夹具、一个过滤谓词 `{ topic: 'browser.agentFocus' }`）都会被算成
    // 发送方 —— 那正好把「零发送方」伪装成「已接」，是这张台账要挡的事故本身。
    /\breplay\(\s*\{\s*topic:\s*(['"`])([\w.]+)\1/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) found.push(m[2]);
  }
  return found;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...walk(full)); continue; }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.includes('.test.')) continue;   // 用例里的 emit 不算生产发送方
    out.push(full);
  }
  return out;
}

const FILES = walk(MAIN_DIR);
const EMITTED = FILES.flatMap((f) => emittedTopicsIn(readFileSync(f, 'utf8')));
const SENDERS = new Set(EMITTED);

/**
 * **声明了、但现在还没有任何地方发它。** 每条都要写清楚谁来接、在哪里接。
 * 接上之后必须从这里划掉 —— 下面第二条用例守着这份名单不许过期。
 */
const PENDING_EMITTER: EventTopic[] = [
  // 空的 —— 每一条 topic 都真的有地方发它。
  //
  // 最后从这里划掉的是 `browser.agentFocus`（Task 8）：发送点是 `browserService`
  // 的 `emitAgentFocus`，由 `markDriving` 与 `withAgentDriving` 的 `finally` 各调一次。
  // 那条信号在主进程本来就有（`registry.setAgentActive` 那一对），但 `setAgentActive`
  // 刻意不推 revision、`toState()` 又把 `isAgentActive` 抹掉，所以 `browser.tabsChanged`
  // 广播带不出来 —— 这正是它必须自成一条 topic 的原因。
];

describe('事件 topic 三方对账：声明 / 已接 / 待接', () => {
  it('每一条 topic 都有交代：要么真的有地方发它，要么明确登记成「待接」', () => {
    const pending = new Set<string>(PENDING_EMITTER);
    // 往 RuntimeEvent 加一条 topic、既没人发也没写进 PENDING_EMITTER → 这里红。
    expect(EVENT_TOPICS.filter((t) => !SENDERS.has(t) && !pending.has(t))).toEqual([]);
  });

  it('「待接」名单不许过期 —— 接上了就要划掉', () => {
    // 补上 emit 却忘了从名单里删掉 → 这里红，名单不会烂在库里。
    // （Task 8 接 `browser.agentFocus` 时正是这条与上一条配成一对：
    //  只补 emit 不划名单红这条，只划名单不补 emit 红上一条。）
    expect(PENDING_EMITTER.filter((t) => SENDERS.has(t))).toEqual([]);
  });

  it('发出去的都是协议里真有的 topic，没有拼错的名字', () => {
    const known = new Set<string>(EVENT_TOPICS);
    expect([...new Set(EMITTED)].filter((t) => !known.has(t))).toEqual([]);
  });

  // 上面三条合起来才穷尽：没有这一条，一个「什么都没扫到」的空表也能靠 PENDING 兜住。
  it('确实扫到了东西 —— 钉住上面几条不是空绿', () => {
    expect(SENDERS.size).toBe(EVENT_TOPICS.length - PENDING_EMITTER.length);
    expect(FILES.length).toBeGreaterThan(50);
  });

  /**
   * 三种调用形态各钉一条：删掉扫描器里任何一条正则，这里会红。
   * 没有这一条的话，「把红的那条正则删了」也是一种让全绿的办法。
   */
  it('三种发送形态都认得', () => {
    expect(SENDERS.has('browser.tabsChanged')).toBe(true);   // broadcaster.emit('x', …)
    expect(SENDERS.has('run.started')).toBe(true);           // emitRun(bound, 'x', …)
    expect(SENDERS.has('run.resync')).toBe(true);            // replay({ topic: 'x', … })
  });
});

/**
 * 扫描器自己也要有人守：它认多了就是假绿（一句注释冒充发送方），
 * 认少了会红（那是安全方向）。
 */
describe('扫描器：注释里的 emit 不算发送方', () => {
  it('真的调用算，注释掉的不算', () => {
    const src = [
      "const url = 'https://x.example/a//b';",
      "broadcaster.emit('run.started', payload);",
      "// broadcaster.emit('browser.agentFocus', payload);",
      "/* emitRun(bound, 'run.ended', payload); */",
      "/** 说明：以后要补 broadcaster.emit('telemetry.status', s) */",
      "emitRun(bound, 'run.message_end', payload);",
      "replay({ topic: 'run.resync', payload });",
    ].join('\n');
    expect(emittedTopicsIn(src).sort()).toEqual(
      ['run.message_end', 'run.resync', 'run.started'],
    );
  });

  it('字符串里的 // 不会被当成注释开头（不许把后面的代码一起吃掉）', () => {
    const src = "log('https://x/'); broadcaster.emit('fs.changed', p);";
    expect(emittedTopicsIn(src)).toEqual(['fs.changed']);
  });

  /**
   * **m5**：第三条正则从前只写 `topic:`，于是**任何**带 topic 字面量的对象都算发送方 ——
   * 一个类型夹具、一个过滤谓词写成 `{ topic: 'browser.agentFocus' }` 就能把
   * 「零发送方」伪装成「已接」，而那正是这张台账要挡的事故本身。收紧成
   * 「必须是 `replay({ topic: … }`」之后，下面第二条才是假的。
   */
  it('只有真的 replay({ topic }) 算发送方，光有 topic 字面量的对象不算', () => {
    expect(emittedTopicsIn("replay({ topic: 'run.resync', payload });")).toEqual(['run.resync']);
    expect(emittedTopicsIn("const want = { topic: 'browser.agentFocus' };")).toEqual([]);
    expect(emittedTopicsIn("if (e.topic === 'run.started') return;")).toEqual([]);
  });
});
