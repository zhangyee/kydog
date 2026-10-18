/**
 * `x_research` 改成动作面之后，63 只证明**协议层**（控制器裁决 R58）：`submit` 立即返回、工作活在
 * 回合之后、`wait` 一次交付所有已收尾未交付的结果、`xResearch.taskGet` 说的是真实状态、真重启之后状态与计数还在、
 * `cancel` 只收尾它自己那一段。卡片级断言（`data-status`、两段行数、取消入口、默认收放）在文件末尾
 * 那几条里：同一次启动、同一条会话，靠卡头（`x-research-objective`）在会话里认出「这一张卡」——
 * `data-status` 会变，不能拿它当定位器。
 *
 * 读这份文件之前先知道夹具上的三件事：
 *
 * 1. **闸门**（第二个 query 的导航响应被扣住）。本地代理（下面那个 `serve`）可以把**某一次**
 *    `/search` 导航的响应留在手里不放，直到用例调用 `releaseHeldQuery()`。扣住的是导航响应本身，
 *    所以那个 query 连一次采集都没开始，任务里那一行停在 `navigating`。开合全是夹具事件
 *    （`holdNextQuery` 与那一次导航真的到达），没有任何时间窗：判据不是 `waitForTimeout`，
 *    而是「代理里确实躺着一个请求」这个协议事实。
 *
 * 2. **`researchRunId` 要跨回合传**。脚本是每轮**先写文件、再发消息**的（fixture session 在回合
 *    边界重读它，见 `fixtureProvider` 的 `prompt`），而这个 id 是 submit 那一刻才铸出来的。
 *    于是流程是「submit 一轮 → 从这一轮的工具输出里解出 id → 写下一轮带 `wait` 的脚本」。
 *    这本身也是被测性质：**工作活过了那一轮**，下一轮才拿得到它的结果。
 *
 * 3. **auth 屏障在新面上是一行的状态**：`submit` 不再阻塞，未登录的搜索返回的是一份「两行
 *    `auth_required`」的交付结果，第二行的 `barrier.reason` 是 `not_attempted:auth_required`。
 *    原生登录点击那一段（真 `sendInputEvent`）与改造前完全一样，一字未改。
 *
 * 一次启动跑完全部说法（`serial`），中间只有一次真重启（进程 pid 会变，见 `a real process restart` 那一条）。
 * 普通帖文本只来自 HTTP 响应（`xWirePages`），DOM 里的 `*_DOM_*` 是诱饵。
 *
 * **这份 spec 一次都不调 `browser.getState`。** 那条 RPC 每调一次就签发一个新 epoch
 * （`handlers.ts` 里写明了），而渲染层只在 bootstrap 那一次把 epoch 抄进 store ——
 * 用例从外面调一次之后，侧栏此后上报的每一份 `syncView` 都会被主进程判为过期丢弃，
 * 原生页永远拿不到 bounds。表现出来就是「侧栏里那页看不见、原生点击落在 (0,0)」，
 * 全程没有任何报错。要核对标签**身份**就用壳里的 `browserTabId` 与 `browser.open` 的返回值。
 *
 * 要核对**活动标签**则用 `browser.tabsChanged` 广播：它的载荷是 `{revision, tabs, activeTabId}`，
 * **刻意不带 epoch**（`types.ts` 的 `BrowserTabsSnapshot` 写明了为什么）。所以读它不会像
 * `getState` 那样把渲染层的 epoch 换掉 —— 这是「研究不抢用户的活动标签」唯一安全的协议出口，
 * 而这条性质在改造后更重要：研究工作跑在 `run.ended` **之后**，那时候用户可能正在读自己的页。
 */
import { test, expect } from '@playwright/test';
import { promises as fs, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import tls from 'node:tls';
import type { AddressInfo, Socket } from 'node:net';
import { launchKydog, teardown, seedProject, newThread, type LaunchedApp } from './helpers';
import { BROWSER_PARTITION } from '../src/main/browser/partition';
import type { RuntimeEvent } from '../src/shared/protocol';
import type { XResearchResult } from '../src/main/x/xResearchTypes';
import type { XResearchDelivery, XResearchDeliveryEnvelope } from '../src/main/x/xResearchTaskShell';
import type { XResearchTaskSnapshot } from '../src/shared/xResearchTask';
import { xWireResponse, WIRE_ROOT, WIRE_PLAIN } from './fixtures/61-browser/xWirePages';
import { xClosurePage } from './fixtures/61-browser/xClosurePages';

type Call = { name: string; args: Record<string, unknown>; toolCallId: string; afterMs?: number };
/** 一张卡在会话里的落位：卡数、它所在那条消息的下标、消息列最后一个子元素的下标。 */
type CardPlacement = { cards: number; messageIndex: number; lastIndex: number };
/** 这一跑里见过的每一段研究 → **创建它的那个回合**（`envelope()` 按第一次出现登记）。
 *  卡片是「一个回合一张」，所以期望的卡数 = 这些回合去重后的大小，不是研究的个数（R81b）。 */
const seenResearchTurns = new Map<string, string>();
type Events = RuntimeEvent[];
type ToolOutcome = { runId: string; callId: string; status: string; text: string };
declare global { interface Window { __xClosureEvents: Events } }

const hosts = ['x.com', 'example.org'];
const cert = readFileSync(path.join(__dirname, 'fixtures/61-browser/tls-cert.pem'), 'utf8');
const key = readFileSync(path.join(__dirname, 'fixtures/61-browser/tls-key.pem'));
const call = (name: string, args: Record<string, unknown>): Call => ({ name, args, toolCallId: randomUUID() });

/** 第一个 query 不被闸门碰：它用来证明「闸门开着的窗口里，这一行已经带着真实帖数」。 */
const FIRST_QUERY = { id: 'top', query: 'fixture primary', purpose: 'initial', product: 'Top' as const };
/** 第二个 query 是闸门扣住的那一次导航（`q=fixture+blocked`）。 */
const SECOND_QUERY = { id: 'latest', query: 'fixture blocked', purpose: 'cross-check', product: 'Latest' as const };
const OBJECTIVE = 'Offline rendered evidence';
const READ_OBJECTIVE = 'Read the observed root';
/** 卡片级断言（文件末尾四条）各自的一段研究：卡头是**用户在这个会话里唯一认得出这张卡的东西**，
 *  也是 e2e 里唯一安全的定位键（`data-status` 会从运行中变到终态）。 */
const LIFECYCLE_OBJECTIVE = 'Card lifecycle evidence';
const CANCEL_OBJECTIVE = 'Card cancel evidence';
const NAVIGATING_CANCEL_OBJECTIVE = 'Card cancel during navigation';
const OCCUPANT_OBJECTIVE = 'Card queue occupant';
/** 重启之后**第一次**采集（没有用户标签、侧栏也还没展开）那一段研究的问题。 */
const RESTART_OBJECTIVE = 'Restart first collection';
/** 批交付那一段研究的问题（一条用例，三次提交，一次 wait）。 */
const BATCH_OBJECTIVE = 'Batch delivery evidence';
/** 同一回合里「取消 → 重试」那两段研究各自的问题（卡头取最早一段，也就是被取消的那段）。 */
const RETRY_OBJECTIVE = 'Card retry evidence';
const RETRY_AFTER_CANCEL_OBJECTIVE = 'Card retry after cancel';
/** 同一段研究提交两次的那一段的问题（卡上应该长出两个轮次头）。 */
const ROUNDS_OBJECTIVE = 'Card rounds evidence';
/** 取消之后接着做同一个目标的那一段的问题（卡上应该只有一段、两个轮次头：R83）。 */
const CONTINUE_OBJECTIVE = 'Card continue after cancel';
/** `browser.createTab` 的 id 形状（`tab_` + uuid 前 8 位）：两个标签 id 相等/不等之前先证明它们是 id。 */
const TAB_ID = /^tab_[0-9a-f]{8}$/;

/** 夹具驱动的闸门：`holdQuery` 非空时，下一次同 `q` 的 `/search` 导航响应被扣住不写回。 */
const gate: { holdQuery: string | null; held: Array<{ url: string; release: () => void }> } = {
  holdQuery: null, held: [],
};

function holdNextQuery(query: string): void {
  expect(gate.held).toHaveLength(0);
  gate.holdQuery = query;
}

/** 放行被扣住的那一次导航，返回它的 URL（调用方断言放行的确实是第二个 query）。 */
async function releaseHeldQuery(): Promise<string | null> {
  const [held] = gate.held.splice(0);
  if (!held) return null;
  held.release();
  return held.url;
}

test.describe('x research task protocol closure (offline)', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp, dir: string, fixture: string, project: string, threadId: string;
  let proxy: http.Server, loggedIn = false;
  const sockets = new Set<Socket>();
  let userTabId: string;
  /** 主研究：闸门那一条、追加的那两次、重启要交付的那一份都在它里面。 */
  let researchRunId = '';
  /** 提交那一轮的 runId：结果的 `runId` 写的是它，不是 `wait` 那一轮。 */
  let researchSubmitRunId = '';
  let rootUrl = '';
  let readSubmitRunId = '';
  /** test 1 末尾把用户页激活回来那一帧：revision 用来切「此后」，标签清单用来认出研究后面新开的那张。 */
  let userTabRevision = 0;
  let baselineTabIds: readonly string[] = [];
  /** 重启后要交付的那一份（主研究里最后提交、故意不交付就跑重启）的提交轮 runId。 */
  let pendingSubmitRunId = '';
  /** 卡片级那一段研究：第一条建它（提交那一轮的 runId 也是它的交付身份），第二条接着看它跑完。 */
  let lifecycleRunId = '';
  let lifecycleSubmitRunId = '';

  const cleanup = async () => {
    try { if (launched) await teardown(launched); }
    finally {
      for (const socket of sockets) socket.destroy();
      await releaseHeldQuery(); // 卡在闸门里的响应不会自己回来（客户端已经没了）：先解开再关服务器
      if (proxy?.listening) await new Promise<void>(r => proxy.close(() => r()));
    }
  };

  /** 本地 origin：X 的页面与 GraphQL 响应、登录确认端点，以及那一道闸门。 */
  async function serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `https://${req.headers.host}`);
    if (url.pathname === '/fixture-login' && req.method === 'POST') { loggedIn = true; res.end('confirmed'); return; }
    if (url.hostname === 'x.com' && !loggedIn && url.pathname !== '/i/jf/onboarding/web') {
      res.writeHead(302, { location: '/i/jf/onboarding/web' }); res.end(); return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(404); res.end(); return; }
    // 闸门：只扣**一次**同 `q` 的搜索导航响应。放行之后同一 URL 正常穿过（后面的 wait 要靠它）。
    if (gate.holdQuery !== null && url.pathname === '/search' && url.searchParams.get('q') === gate.holdQuery) {
      gate.holdQuery = null;
      console.info('[held-navigation]', url.href);
      await new Promise<void>((release) => {
        const done = (): void => {
          gate.held = gate.held.filter((entry) => entry.release !== done);
          res.off('close', done);
          release();
        };
        gate.held.push({ url: url.href, release: done });
        // 客户端放弃（导航超时 / 取消）时也要解开，否则这里会一直挂着一份没人要的响应体。
        res.on('close', done);
      });
      if (res.destroyed || res.writableEnded) { console.info('[held-navigation-abandoned]', url.href); return; }
    }
    const wire = xWireResponse(url);
    res.writeHead(200, { 'content-type': wire === null ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
    res.end(wire ?? xClosurePage(url, loggedIn));
  }

  test.beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-x-closure-'));
    console.info('[isolated-fixture-directory]', dir);
    project = path.join(dir, 'project'); fixture = path.join(dir, 'fixture.json');
    await fs.mkdir(project); await fs.writeFile(fixture, JSON.stringify({ events: [] }));
    const origin = http.createServer((req, res) => {
      void serve(req, res).catch((error: unknown) => {
        console.error('[origin-failure]', error);
        try { res.destroy(); } catch { /* 已经没了 */ }
      });
    });
    origin.on('clientError', (_e, s) => s.destroy());
    proxy = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
    proxy.on('connection', s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
    proxy.on('connect', (req, socket: Socket, head) => {
      if (!hosts.some(host => req.url === `${host}:443`)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) socket.unshift(head);
      origin.emit('connection', new tls.TLSSocket(socket, { isServer: true, key, cert, ALPNProtocols: ['http/1.1'] }));
    });
    try {
      await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
      launched = await launchKydog({ fixture, seed: home => seedProject(home, project) });
      await configure();
      threadId = await newThread(launched.page);
      userTabId = (await launched.page.evaluate(() => window.kydog.invoke('browser.open', { url: 'https://example.org/user-tab' }))).tabId;
    } catch (error) { await cleanup(); throw error; }
  });
  test.afterAll(cleanup);

  async function configure() {
    const port = (proxy.address() as AddressInfo).port;
    expect(await launched.app.evaluate(async ({ session }, a) => {
      const ses = session.fromPartition(a.partition);
      await ses.setProxy({ proxyRules: `http://127.0.0.1:${a.port}` });
      ses.setCertificateVerifyProc((req, cb) => cb(a.hosts.includes(req.hostname) && req.certificate.data.replace(/\s/g, '') === a.cert.replace(/\s/g, '') ? 0 : -3));
      return ses.resolveProxy('https://x.com/search');
    }, { port, partition: BROWSER_PARTITION, hosts, cert })).toBe(`PROXY 127.0.0.1:${port}`);
    await launched.page.evaluate(async () => {
      const settings = await window.kydog.invoke('research.get');
      await window.kydog.invoke('research.save', { ...settings, xResearchEnabled: true });
      window.__xClosureEvents = [];
      const topics = ['run.started', 'run.tool_call_chunk', 'run.tool_call_end', 'run.ended', 'run.ask_start', 'run.ask_end',
        // 活动标签那条性质的观测口。**不是 `browser.getState`** —— 那条每调一次就换 epoch（见文件头）。
        'browser.tabsChanged'] as const;
      for (const topic of topics) window.kydog.on(topic, payload => window.__xClosureEvents.push({ topic, payload } as RuntimeEvent));
    });
  }

  /** 一轮：写脚本 → 发消息 → 等 `run.ended`。脚本每轮重写：下一轮的 `wait` 要带上这一轮才铸出来的 id。
   *  `endedClaim` 是「这一轮必须自己结束」那条断言失败时的说法：若某个工具退化成阻塞，轮次就停在
   *  tool_call 里，失败只剩一个裸 `expect.poll` 超时，读不出在等什么性质。 */
  async function run(calls: Call[], during?: () => Promise<void>, endedClaim?: string): Promise<ToolOutcome[]> {
    await fs.writeFile(fixture, JSON.stringify({ events: [
      { type: 'agent_start', after_ms: 0 },
      ...calls.map(c => ({ name: c.name, args: c.args, toolCallId: c.toolCallId,
        type: 'tool', after_ms: c.afterMs ?? 0 })),
      { type: 'agent_end', reason: 'completed', after_ms: 0 },
    ] }));
    const { runId } = await launched.page.evaluate(a => window.kydog.invoke('thread.send', a), { threadId, content: randomUUID() });
    if (during) await during();
    const events = () => launched.page.evaluate(a => window.__xClosureEvents.filter(e => e.payload && 'runId' in e.payload && e.payload.runId === a.runId && 'threadId' in e.payload && e.payload.threadId === a.threadId), { threadId, runId });
    // 这一轮必须自己收尾（`reason: 'completed'` 另断在下一句）。工具若退化成阻塞，`run.ended`
    // 永远不来 —— 消息把「等着的是哪个性质」说出来。
    await expect.poll(async () => (await events()).some(e => e.topic === 'run.ended'),
      { message: endedClaim ?? 'the turn ended (run.ended) instead of staying inside a tool call' }).toBe(true);
    const received = await events();
    expect(received.find(e => e.topic === 'run.ended')).toMatchObject({ payload: { reason: 'completed' } });
    return calls.map(c => {
      if (c.name === 'ask_user_question') {
        const answered = received.find(e => e.topic === 'run.ask_end' && e.payload.toolCallId === c.toolCallId);
        expect(answered).toMatchObject({ payload: { outcome: { kind: 'answered' } } });
        return { runId, callId: c.toolCallId, status: 'ok', text: '' };
      }
      const end = received.find(e => e.topic === 'run.tool_call_end' && e.payload.toolCallId === c.toolCallId);
      expect(end).toBeTruthy();
      return { runId, callId: c.toolCallId, status: end?.topic === 'run.tool_call_end' ? end.payload.status : '',
        text: received.flatMap(e => e.topic === 'run.tool_call_chunk' && e.payload.toolCallId === c.toolCallId ? [e.payload.chunk] : []).join('') };
    });
  }

  /** 工具输出就是壳本身：`content[0].text` 是它的 JSON，四个协议键一个都不会被省。 */
  function envelope(outcome: ToolOutcome): XResearchDeliveryEnvelope {
    expect(outcome.status).toBe('ok');
    const parsed = JSON.parse(outcome.text) as XResearchDeliveryEnvelope;
    expect(parsed.kind).toBe('x_research');
    expect(parsed.researchRunId).toBeTruthy();
    // 第一次见到这段研究的那次调用就是它的创建回合：后来的 submit 只是追加，wait / inspect / cancel
    // 更是别的回合在提到它。分组键（`runId`）只在创建时定下来。
    if (!seenResearchTurns.has(parsed.researchRunId)) {
      seenResearchTurns.set(parsed.researchRunId, outcome.runId);
    }
    const rowsOf = (delivery: XResearchDelivery) => delivery.operation === 'search'
      ? (delivery.result as Extract<XResearchResult, { operation: 'search' }>).queries.map(q => ({ status: q.status, stopReason: q.stopReason, posts: q.posts.map(p => p.postId) }))
      : (delivery.result as Extract<XResearchResult, { operation: 'read' }>).targets.map(t => ({ status: t.status, stopReason: t.stopReason, root: t.root?.postId ?? null }));
    const deliveries = parsed.deliveries ?? (parsed.delivery ? [parsed.delivery] : []);
    console.info('[x-envelope]', JSON.stringify({ action: parsed.action, researchRunId: parsed.researchRunId,
      status: parsed.status, counts: parsed.snapshot.counts, undelivered: parsed.undelivered,
      deliveries: deliveries.map((delivery) => ({ submissionId: delivery.submissionId, submitCallId: delivery.submitCallId, operation: delivery.operation, rows: rowsOf(delivery) })) }));
    return parsed;
  }

  /** 交付结果的规范形状：`schemaVersion: 2`，`runId` 是**提交**那一轮，`callId` 与壳里的提交身份一致。 */
  function canonical(delivery: XResearchDelivery, submitRunId: string): XResearchResult {
    expect(delivery.result).toMatchObject({
      schemaVersion: 2, runId: submitRunId, callId: delivery.submitCallId, operation: delivery.operation,
    });
    return delivery.result;
  }

  const taskGet = (researchRunId: string): Promise<XResearchTaskSnapshot> =>
    launched.page.evaluate(a => window.kydog.invoke('xResearch.taskGet', a), { threadId, researchRunId });

  /** 至今收到的每一帧 `browser.tabsChanged`：活动标签 + 那一刻的标签清单（带 revision 用来切窗口）。 */
  const tabFrames = (): Promise<Array<{ revision: number; activeTabId: string | null; tabIds: string[] }>> =>
    launched.page.evaluate(() => window.__xClosureEvents
      .filter((e): e is Extract<RuntimeEvent, { topic: 'browser.tabsChanged' }> => e.topic === 'browser.tabsChanged')
      .map(e => ({ revision: e.payload.revision, activeTabId: e.payload.activeTabId, tabIds: e.payload.tabs.map(t => t.id) })));

  /** 基线（`userTabRevision`）之后每一帧说的活动标签，去重。 */
  const activeTabsSinceUserTab = async (): Promise<Array<string | null>> => [...new Set((await tabFrames())
    .filter(frame => frame.revision > userTabRevision).map(frame => frame.activeTabId))];

  /** 基线之后新出现的标签 id —— 就是研究自己开的那一页（提交那一刻它还在排队，开页在 `run.ended` 之后）。 */
  const researchTabsSinceUserTab = async (): Promise<string[]> => [...new Set((await tabFrames())
    .filter(frame => frame.revision > userTabRevision).flatMap(frame => frame.tabIds)
    .filter(id => !baselineTabIds.includes(id)))];

  const searchArgs = (queries: readonly (typeof FIRST_QUERY | typeof SECOND_QUERY)[], objective: string = OBJECTIVE) => ({
    search: { objective, queries, maxPostsPerQuery: 3, maxScrollsPerQuery: 0 },
  });
  const readArgs = (url: string) => ({
    read: { objective: READ_OBJECTIVE, targets: [{ url }], includeArticle: false, includeReplies: false,
      maxScrollsPerPost: 0, maxExpandActionsPerPost: 0 },
  });

  // ── 卡片级观测（文件末尾那四条的观测口）──

  /** 会话里的一个回合的那张卡。卡头（`x-research-objective`）是**最早一段**研究的第一份提交的问题
   *  （R10），它在这一回合的一生里不变；`data-status` 会从运行中走到终态，所以不能用它定位。
   *  一张卡跟着「最后一次提到这个回合任何一段研究的那条消息」走，所以任何时刻每回合最多一张。
   *  传的是**最早一段**的 objective；后面几段的目标在各段自己的分段头里。 */
  const cardFor = (objective: string) => launched.page.locator('[data-testid="x-research-card"]')
    .filter({ has: launched.page.locator('[data-testid="x-research-objective"]', { hasText: objective }) });

  /** 会话里卡的总数。**一个回合一张**（R81b）：期望值就是这些研究所属回合去重后的大小，
   *  于是「同一回合的第二段研究并进同一张卡」与「没有多出来一张来历不明的卡」是同一条断言。
   *  `toHaveCount` 会重试，所以 buffer → history 那一瞬的重复、以及第二段快照到达前的一瞬不算。 */
  const expectOneCardPerRun = async (): Promise<void> => {
    await expect(launched.page.getByTestId('x-research-card'),
      '会话里每个回合各一张卡（卡数 = 见过的创建回合个数）')
      .toHaveCount(new Set(seenResearchTurns.values()).size);
  };

  /** 这张卡停在会话里的哪一条消息上。`message-list` 那一列的直接子元素就是消息（用户一条、
   *  助手一条），所以「卡在最后一次提到它的那条消息里」= 卡所在的那个直接子元素就是这一列的
   *  最后一个子元素（此时没有在跑的消息，列尾就是最后一条）。带回两个序号，红的时候说得清
   *  它实际停在哪一条。 */
  async function cardPlacement(objective: string): Promise<CardPlacement> {
    return launched.page.evaluate((text) => {
      const cards = [...document.querySelectorAll('[data-testid="x-research-card"]')]
        .filter((card) => card.querySelector('[data-testid="x-research-objective"]')?.textContent?.trim() === text);
      const column = document.querySelector('[data-testid="message-list"]')?.firstElementChild;
      if (!column) throw new Error('message list column missing');
      let anchor: Element | null = cards[0] ?? null;
      while (anchor && anchor.parentElement !== column) anchor = anchor.parentElement;
      return { cards: cards.length, messageIndex: anchor ? [...column.children].indexOf(anchor) : -1,
        lastIndex: column.children.length - 1 };
    }, objective);
  }

  /** 断这张卡此刻的落位，**以稳定态为准**：`cardPlacement` 是一次 `page.evaluate`，读的是同一帧 ——
   *  buffer→history 那一瞬（同一份结果既在 buffer 里又已进 history）会读到两张卡，或者卡还挂在
   *  旧消息上。`toHaveCount` 那条已经会重试，这两条也得会重试：被断的性质是「最终回到一张、停在
   *  它该在的那条消息里」，不是「某一帧恰好如此」。失败信息带上实际读到的三个数。 */
  async function expectCardPlacement(objective: string, claim: string,
    holds: (placed: CardPlacement) => boolean): Promise<void> {
    await expect.poll(async () => {
      const placed = await cardPlacement(objective);
      return holds(placed) ? 'settled'
        : `cards=${placed.cards} messageIndex=${placed.messageIndex} lastIndex=${placed.lastIndex}`;
    }, { message: claim }).toBe('settled');
  }

  test('an unauthenticated research delivers the auth barrier as row status; a native fixture login clears it', async () => {
    const submitRun = await run([call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY, SECOND_QUERY]) })]);
    const submitted = envelope(submitRun[0]);
    expect(submitted.action).toBe('submit');
    expect(submitted.status).toBe('running');
    // submit 不带交付、wait 带：同一条用例里两种形状都在，`deliveries` 这个字段确实会出现在壳上。
    expect(submitted.deliveries).toBeUndefined();
    const authRun = await run([call('x_research', { action: 'wait', researchRunId: submitted.researchRunId })]);
    const delivered = envelope(authRun[0]);
    expect(delivered.deliveries).toHaveLength(1);
    const result = canonical(delivered.deliveries![0]!, submitRun[0].runId);
    if (result.operation !== 'search') throw new Error('search expected');
    expect(result.queries.map(q => q.status)).toEqual(['auth_required', 'auth_required']);
    expect(result.queries[1].barrier?.reason).toBe('not_attempted:auth_required');
    // 有失败 > 完成：barrier 是源侧的拒绝事实，不是「还没跑」。
    expect(delivered.status).toBe('failed');
    expect(delivered.snapshot.counts).toMatchObject({ submissions: 1, failed: 2, done: 0, posts: 0, undelivered: 0 });
    const taskTabId = delivered.snapshot.browserTabId;
    expect(taskTabId).toBeTruthy();
    expect(result.browserTabId).toBe(taskTabId);
    // 任务那一页与用户那一页是两个真实的标签（同一套 id 形状），不是一个。
    expect(userTabId).toMatch(TAB_ID);
    expect(taskTabId).toMatch(TAB_ID);
    expect(taskTabId).not.toBe(userTabId);

    const ask = call('ask_user_question', { browserTabId: taskTabId, questions: [{ header: 'Login', question: 'Confirm this isolated fixture login?', options: [{ label: 'Confirmed', description: 'Fresh fixture human confirmation' }, { label: 'Cancel', description: 'Stop' }] }] });
    await run([ask], async () => {
      await expect(launched.page.getByTestId('question-composer')).toBeVisible();
      // 问句要问的是任务页的那一屏：侧栏确实把那页摆出来了（也是接下来那次原生点击的几何前提）。
      await expect(launched.page.locator('[data-pane="browser"]')).toBeVisible();
      // 原生 view 拿到真实 bounds 之后才能算点击坐标：侧栏刚摆出来时那一刻还是 0×0（
      // ResizeObserver 的下一帧才上报 stage），此时算出来的点永远落在 (0,0)。
      const authViewBounds = () => launched.app.evaluate(({ webContents, BrowserWindow }) => {
        const views = webContents.getAllWebContents().filter(w => w.getURL().includes('/i/jf/onboarding/web'));
        if (views.length !== 1) throw new Error('Expected original auth view');
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents === views[0]);
        if (!view) throw new Error('Missing native auth view');
        return view.getBounds();
      });
      await expect.poll(async () => (await authViewBounds()).width).toBeGreaterThan(0);
      // Native trusted mouse delivery supplies the fixture user's login confirmation.
      const click = await launched.app.evaluate(async ({ webContents, BrowserWindow }) => {
        const views = webContents.getAllWebContents().filter(w => w.getURL().includes('/i/jf/onboarding/web'));
        if (views.length !== 1) throw new Error('Expected original auth view');
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => 'webContents' in v && (v as import('electron').WebContentsView).webContents === views[0]);
        if (!view) throw new Error('Missing native auth view');
        const logical = await views[0].executeJavaScript("(()=>{const r=document.querySelector('#fixtureLogin').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})()") as { x: number; y: number; width: number };
        const bounds = view.getBounds();
        const scale = bounds.width / logical.width;
        const point = { x: Math.round(logical.x * scale), y: Math.round(logical.y * scale) };
        views[0].sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
        views[0].sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
        return { logical, bounds, point };
      });
      console.info('[fixture-human-click]', JSON.stringify(click));
      await expect.poll(() => launched.app.evaluate(async ({ webContents }) => {
        const view = webContents.getAllWebContents().find(w => w.getURL().includes('/i/jf/onboarding/web'))!;
        return view.executeJavaScript('document.body.dataset.fixtureConfirmed');
      })).toBe('true');
      await launched.page.getByRole('button', { name: 'Confirmed', exact: false }).click();
      await launched.page.getByTestId('ask-submit').click();
    });
    const asks = await launched.page.evaluate(() => window.__xClosureEvents.filter(e => e.topic === 'run.ask_start'));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ payload: { toolCallId: ask.toolCallId, threadId, browserTabId: taskTabId } });
    // 用户回到自己那一页：之后的任务页一次都不许把它抢走。
    await launched.page.evaluate(id => window.kydog.invoke('browser.activate', { tabId: id }), userTabId);
    // 基线（广播自己说的）：活动标签是用户那一页。这一帧的 revision 是闸门窗口与取消那一条
    // 切「此后」的分界线，标签清单用来认出研究后面新开的那张（两张都存下来给下面两条用）。
    await expect.poll(async () => (await tabFrames()).at(-1)?.activeTabId ?? null,
      { message: `the user tab ${userTabId} is the active tab right after browser.activate(userTabId)` }).toBe(userTabId);
    const baselineFrame = (await tabFrames()).at(-1);
    if (!baselineFrame) throw new Error('一帧 browser.tabsChanged 都没到：这个观测量本身坏了');
    userTabRevision = baselineFrame.revision;
    baselineTabIds = baselineFrame.tabIds;
  });

  test('submit returns at once while the held second query has not been collected and the first row carries the wire counts', async () => {
    holdNextQuery(SECOND_QUERY.query);
    const submitRun = await run([call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY, SECOND_QUERY]) })], undefined,
      'the submit turn ended while the research was still running');
    const submitted = envelope(submitRun[0]);
    researchRunId = submitted.researchRunId;
    researchSubmitRunId = submitRun[0].runId;
    expect(submitted.action).toBe('submit');
    expect(submitted.status).toBe('running');
    // 这一轮已经结束（`run` 断过 reason=completed），而工作在跑：submit 不阻塞。
    expect((await taskGet(researchRunId)).state).toBe('running');
    // 研究用的那一页由任务自己说（`taskGet` 的 `browserTabId` 是权威，R81h）：同一个对话里的新研究
    // 继承本对话当前页，所以它可能正是基线上已有的那一张 ——「开一张新标签」不再是这条研究的形状。
    // 要钉的性质没变：先证明研究那一页真的被广播过（否则下面那条就是「什么都没观测到」），再证明
    // 基线之后每一帧说的活动标签都只有用户那一页。（`browser.getState` 也读得到 `activeTabId`，但它
    // 每调一次就换 epoch，会把侧栏静音 —— 见文件头。）
    const researchTabId = (await taskGet(researchRunId)).browserTabId;
    expect(researchTabId, 'the task names the tab the research works in').toBeTruthy();
    await expect.poll(async () => [...baselineTabIds, ...await researchTabsSinceUserTab()],
      { message: `the research tab ${researchTabId} was broadcast` }).toContain(researchTabId);
    expect(await activeTabsSinceUserTab(), `the research's tab ${researchTabId} must not become the active tab`).toEqual([userTabId]);
    // 闸门里躺着第二个 query 的那次导航 —— 正向证明这一行「到了、没拿到页面」，不是「从没试过」。
    await expect.poll(() => gate.held.map(entry => new URL(entry.url).pathname)).toEqual(['/search']);
    expect(new URL(gate.held[0].url).searchParams.get('q')).toBe(SECOND_QUERY.query);
    // 第一行**已经收尾**（`maxScrollsPerQuery: 0` ⇒ 收完那一页就撞预算），第二行才停在闸门里：
    // 这正是 R81g 修的那件事 —— 收尾了的行说「收完 / 预算用尽」，不再一直挂着「收集中」（分子因此
    // 不再是 0）。两行都在飞时这条就分不出「谁收尾了」。
    await expect.poll(async () => (await taskGet(researchRunId)).search.map(
      row => ({ label: row.label, state: row.state, posts: row.posts, scrolls: row.scrolls, pages: row.pages })))
      .toEqual([
        { label: FIRST_QUERY.query, state: 'stopped', posts: 2, scrolls: 0, pages: 1 },
        { label: SECOND_QUERY.query, state: 'navigating', posts: 0, scrolls: 0, pages: 0 },
      ]);
    const heldWindow = await taskGet(researchRunId);
    expect(heldWindow.state).toBe('running');
    expect(heldWindow.objective).toBe(OBJECTIVE);
    // 这里不断 `budget`：每个夹具都把 `maxScrollsPerQuery` 声明成 0，而快照里的 `budget` 是
    // 各次提交**声明值**的累加（xResearchTask 的 `budget.scrolls += submission.budget.scrolls`），
    // 于是那条断言是「零的和等于零」—— 恒真（R59b）。真实数额在下面这几桶里：
    // `done` 是撞上预算收尾的第一行，`running` 是还停在闸门里的第二行，`posts` 是 wire 夹具已服务的两条。
    expect(heldWindow.counts).toMatchObject({
      submissions: 1, queued: 0, running: 1, done: 1, searchDone: 1, posts: 2, undelivered: 0,
    });
  });

  test('releasing the held navigation lets one wait deliver exactly one canonical result', async () => {
    expect(await releaseHeldQuery()).toContain('/search');
    const waitRun = await run([call('x_research', { action: 'wait', researchRunId })]);
    const delivered = envelope(waitRun[0]);
    expect(delivered.action).toBe('wait');
    expect(delivered.deliveries).toHaveLength(1);
    const delivery = delivered.deliveries![0]!;
    expect(delivery.operation).toBe('search');
    const result = canonical(delivery, researchSubmitRunId);
    if (result.operation !== 'search') throw new Error('search expected');
    expect(result.status).toBe('partial');
    for (const row of result.queries) {
      expect(row.posts.map(post => post.text)).toEqual([WIRE_ROOT, WIRE_PLAIN]);
      expect(row.stopReason).toBe('budget_reached');
      expect(row.budgetUsage).toMatchObject({ scrolls: 0, expandActions: 0 });
    }
    rootUrl = 'https://x.com/reader/status/321';
    expect(result.queries[0].posts[0].sourceUrl).toBe(rootUrl);
    // 任务页就是闸门窗口里快照说的那一页（不是用户的活动标签）。
    expect(result.browserTabId).toMatch(TAB_ID);
    expect(delivered.snapshot.browserTabId).toBe(result.browserTabId);
    expect(result.browserTabId).not.toBe(userTabId);
    expect(delivered.status).toBe('completed');
    expect(delivered.snapshot.counts).toMatchObject({ submissions: 1, done: 2, failed: 0, posts: 4, undelivered: 0 });
    expect(delivered.snapshot.usage).toEqual({ posts: 4, scrolls: 0, expandActions: 0 });
    // 交付的那一份是收尾时落过盘的那份字节（工件可定位、路径真实存在）。
    expect(result.delivery).toMatchObject({ persistence: 'saved', truncated: false });
    expect((await fs.stat(result.delivery!.artifactPath!)).isFile()).toBe(true);
  });

  test('a second submission appends to the same research and one wait delivers both finished results', async () => {
    const outcomes = await run([
      call('x_research', { action: 'submit', researchRunId, ...searchArgs([FIRST_QUERY]) }),
      call('x_research', { action: 'submit', researchRunId, ...readArgs(rootUrl) }),
    ]);
    const appended = envelope(outcomes[0]);
    const readSubmitted = envelope(outcomes[1]);
    readSubmitRunId = outcomes[1].runId;
    expect(appended.researchRunId).toBe(researchRunId);
    expect(readSubmitted.researchRunId).toBe(researchRunId);
    expect(readSubmitted.snapshot.counts.submissions).toBe(3);
    // 卡头永远是最早一次提交要回答的问题（R10）：追加读取不让它换题。
    expect(readSubmitted.snapshot.objective).toBe(OBJECTIVE);
    const waitRun = await run([call('x_research', { action: 'wait', researchRunId })]);
    const delivered = envelope(waitRun[0]);
    // 一次 `wait` 交回这一轮已经收尾的两份（上一轮的 search 与这一轮的 read），按提交顺序；
    // 每条都是独立的一份交付，各自带着自己的提交身份。
    expect(delivered.deliveries).toHaveLength(2);
    const searchDelivery = delivered.deliveries!.find(delivery => delivery.operation === 'search');
    const readDelivery = delivered.deliveries!.find(delivery => delivery.operation === 'read');
    if (!searchDelivery || !readDelivery) throw new Error('both submissions must be delivered');
    canonical(searchDelivery, outcomes[0].runId);
    const readResult = canonical(readDelivery, readSubmitRunId);
    if (readResult.operation !== 'read') throw new Error('read expected');
    expect(readResult.targets[0]).toMatchObject({
      status: 'observed', root: { postId: '321', text: WIRE_ROOT, sourceUrl: rootUrl },
    });
    expect(delivered.undelivered).toBeUndefined();
    expect(delivered.snapshot.counts).toMatchObject({ submissions: 3, done: 4, undelivered: 0, posts: 6 });
    // 正控：第二次 `wait` 一份都不重复交付。
    const again = envelope((await run([call('x_research', { action: 'wait', researchRunId })]))[0]);
    expect(again.deliveries).toBeUndefined();
    expect(again.undelivered).toBeUndefined();
  });

  test('cancel settles a research whose only submission never ran; a finished delivery is still retrievable', async () => {
    holdNextQuery(SECOND_QUERY.query);
    // 先占住这条 thread 的队列（第二个 query 被闸住 ⇒ 它不会很快收尾），第二份提交因此真的**排队**着。
    const occupyingRun = await run([
      call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY, SECOND_QUERY]) }),
      call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY]) }),
    ]);
    const occupying = envelope(occupyingRun[0]);
    const queued = envelope(occupyingRun[1]);
    expect(occupying.researchRunId).toBeTruthy();
    expect(queued.researchRunId).toBeTruthy();
    expect(queued.researchRunId).not.toBe(occupying.researchRunId);
    expect(queued.status).toBe('running');
    await expect.poll(() => gate.held.length).toBe(1);
    const beforeCancel = await taskGet(queued.researchRunId);
    expect(beforeCancel.counts).toMatchObject({ submissions: 1, queued: 1, running: 0, cancelled: 0 });
    const cancelledRun = await run([
      call('x_research', { action: 'cancel', researchRunId: queued.researchRunId }),
      call('x_research', { action: 'submit', researchRunId: queued.researchRunId, ...searchArgs([FIRST_QUERY]) }),
    ]);
    const cancelled = envelope(cancelledRun[0]);
    expect(cancelled.action).toBe('cancel');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.snapshot.stateReason).toBe('cancelled');
    expect(cancelled.snapshot.counts).toMatchObject({ submissions: 1, cancelled: 1, queued: 0, running: 0, posts: 0 });
    // 取消只作用于**这一次的工作**（R83）：被取消的那一份永不重跑、也永远不会变成「没取消过」，
    // 但同一段研究可以继续追加 —— 那是新的一轮，不是「静默复活」旧的那一份。
    expect(cancelledRun[1].status).toBe('ok');
    expect(envelope(cancelledRun[1]).action).toBe('submit');
    // 盘上是两份提交：被取消的那份 + 刚追加的那一轮；取消事实粘在前者身上。
    expect((await taskGet(queued.researchRunId)).counts)
      .toMatchObject({ submissions: 2, cancelled: 1 });

    // 放行占住队列的那一段：它照常交付自己的结果，被取消的那一段跟它无关。
    expect(await releaseHeldQuery()).toContain('/search');
    const occupyingWait = envelope((await run([call('x_research', { action: 'wait', researchRunId: occupying.researchRunId })]))[0]);
    expect(occupyingWait.deliveries).toHaveLength(1);
    expect(occupyingWait.snapshot.state).toBe('completed');
    const occupyingResult = canonical(occupyingWait.deliveries![0]!, occupyingRun[0].runId);
    if (occupyingResult.operation !== 'search') throw new Error('search expected');
    expect(occupyingResult.queries.map(row => row.status)).toEqual(['partial', 'partial']);

    // 主研究早就收尾的两份已经在上一轮交过了；取消别人不会让它们回到未交付。
    expect((await taskGet(researchRunId)).state).toBe('completed');
    const pendingRun = await run([call('x_research', { action: 'submit', researchRunId, ...searchArgs([FIRST_QUERY]) })]);
    expect(pendingRun[0].status).toBe('ok');
    pendingSubmitRunId = pendingRun[0].runId;
    // 新的那份照常收尾，停在「已收尾未交付」——重启那一条要交付的正是它。这里**不 wait**：
    // 一次 wait 会把它也交出去，重启就没有待交付的结果了。
    await expect.poll(async () => (await taskGet(researchRunId)).counts)
      .toMatchObject({ submissions: 4, undelivered: 1, posts: 8 });

    // 这一段研究从头到尾（闸门那一次、追加的两次、被取消那一段）自己开了页、导航、交付，
    // 而活动标签一次都没被它抢走。两条断合起来才是这条性质：
    // ①此后确实还有研究自己开的新标签（观测量是活的，不是没观测到东西）；
    // ②这些帧说的活动标签永远是用户那一页（`browserService.open` 里 `activate === true` 只有
    //   用户自己在地址栏那条路才传，研究侧 `xResearchBrowser.open` 传的是 false）。
    expect((await tabFrames()).some(frame => frame.revision > userTabRevision),
      'frames kept arriving after the baseline').toBe(true);
    const researchTabs = [...new Set((await tabFrames())
      .filter(frame => frame.revision > userTabRevision).flatMap(frame => frame.tabIds))];
    expect(researchTabs, 'the research tabs were broadcast').toContain(
      (await taskGet(researchRunId)).browserTabId);
    expect(await activeTabsSinceUserTab(), `research tabs ${researchTabs.join(',')} must not become the active tab`).toEqual([userTabId]);
  });

  test('a real process restart keeps the run state and counts, and wait still delivers the undelivered result', async () => {
    const home = launched.kydogHome, oldPid = launched.app.process().pid;
    expect(oldPid).toBeGreaterThan(0);
    await teardown(launched);
    launched = await launchKydog({ fixture, kydogHome: home });
    await configure();
    expect(launched.app.process().pid).toBeGreaterThan(0);
    expect(launched.app.process().pid).not.toBe(oldPid);
    // 冷启动落在欢迎页：先真的打开这条对话（`taskGet` 只答「正在看这个对话的主窗口」）。
    await launched.page.getByTestId(`thread-${threadId}`).click();
    await expect(launched.page.locator('[data-thread-id]').first()).toHaveAttribute('data-thread-id', threadId);
    const history = await launched.page.evaluate(id => window.kydog.invoke('thread.loadHistory', { threadId: id }), threadId);
    expect(JSON.stringify(history)).toContain(WIRE_ROOT);

    // 第一次建会话的那一轮：`inspect` 读的是盘上那批记录（也是这一轮把任务 service 接上）。
    const inspected = envelope((await run([call('x_research', { action: 'inspect', researchRunId, view: 'deliveries' })]))[0]);
    expect(inspected.action).toBe('inspect');
    expect(inspected.snapshot.counts).toMatchObject({ submissions: 4, done: 5, undelivered: 1, posts: 8 });
    const deliveries = inspected.inspect!.items as Array<{ operation: string; deliveredAt: string | null; hasArtifact: boolean }>;
    expect(deliveries.map(item => item.operation)).toEqual(['search', 'search', 'read', 'search']);
    expect(deliveries.map(item => item.deliveredAt !== null)).toEqual([true, true, true, false]);
    expect(deliveries.map(item => item.hasArtifact)).toEqual([true, true, true, true]);
    // 重启后的 `taskGet`：状态与计数都是盘上那一份，不是内存里重算的。
    const restored = await taskGet(researchRunId);
    expect(restored.state).toBe('completed');
    expect(restored.objective).toBe(OBJECTIVE);
    expect(restored.counts).toMatchObject({ submissions: 4, done: 5, posts: 8, undelivered: 1 });

    const waitRun = await run([call('x_research', { action: 'wait', researchRunId })]);
    const delivered = envelope(waitRun[0]);
    expect(delivered.deliveries).toHaveLength(1);
    const delivery = delivered.deliveries![0]!;
    const result = canonical(delivery, pendingSubmitRunId);
    if (result.operation !== 'search') throw new Error('search expected');
    expect(result.queries[0].posts.map(post => post.text)).toEqual([WIRE_ROOT, WIRE_PLAIN]);
    // 重启后没有内存里的那份结果：交付走工件读回（R20），持久化与路径都得说得出来。
    expect(result.delivery).toMatchObject({ persistence: 'saved', truncated: false });
    expect((await fs.stat(result.delivery!.artifactPath!)).isFile()).toBe(true);
    expect(result.artifact).toBeTruthy();
    expect(delivered.snapshot.counts.undelivered).toBe(0);
    const after = await taskGet(researchRunId);
    expect(after.state).toBe('completed');
    expect(after.counts.undelivered).toBe(0);
  });

  test('the first collection after a restart reaches the wire even though the sidebar flaps the stage mid-collection', async () => {
    // 重启把主进程的标签表清空了（标签表在内存里），但**渲染层的侧栏会被上一条自己打开**：
    // 上一条的 `thread.loadHistory` 把 journal 重放进 store，test 1 那条 `run.ask_start`
    // 带着 `browserTabId`，于是 `handOffToBrowser` 把侧栏展开（`runEvents.ts` 登记过的观感问题）。
    // 先像用户那样把它收起来 —— 这条要走的起点就是「这个进程里侧栏还没展开、一个标签也没有」，
    // 也是下面那句「采集进行中才展开侧栏」能成立的前提。**这一步的前提自己也断一下**：
    // 侧栏是上一条的 journal 重放留下的（`runEvents.ts` 登记的观感问题），将来它不再展开时，
    // 这一下点击就变成了「打开」，会红在一个看不出在等什么的地方。
    await expect(launched.page.locator('[data-pane="browser"]'), '上一条的 journal 重放把侧栏留在了展开状态：这一下点击是「收起来」')
      .toBeVisible();
    await launched.page.getByTestId('titlebar-browser').click();
    await expect(launched.page.locator('[data-pane="browser"]')).toHaveCount(0);

    // 闸门扣住第二个 query 的导航：研究在**采集进行中**停住（第一行已收、第二行停在 navigating），
    // 用户才有机会在采集跑着的时候去点侧栏 —— 否则整段采集比一次点击还短，跳动一定落在采集之后。
    holdNextQuery(SECOND_QUERY.query);
    const submitRun = await run([call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY, SECOND_QUERY], RESTART_OBJECTIVE) })],
      undefined, 'the submit turn ended while the research was still running');
    const submitted = envelope(submitRun[0]);
    expect(submitted.status).toBe('running');
    const restartRunId = submitted.researchRunId;
    await expect.poll(() => gate.held.map(entry => new URL(entry.url).pathname)).toEqual(['/search']);
    // 第一行已收尾（撞预算 ⇒ `stopped`），第二行停在闸门里 —— 采集仍在进行（R81g 之后，
    // 「收尾」是行自己说的，不再等到整批结束才统一落成 `stopped`）。
    await expect.poll(async () => (await taskGet(restartRunId)).search.map(row => row.state))
      .toEqual(['stopped', 'navigating']);
    // 研究自己开的那一页是**唯一**的标签（用户没有自己的页），所以它是活动标签。
    // 横幅只为活动标签出现（`agentBanner` 的判据），这是下面那次舞台跳动的前提，先证明它在。
    // 标签 id 只能从广播里拿：`taskGet` 的 `browserTabId` 要等 `browser.open` 返回才写进记录，
    // 而它要等这次导航落地 —— 此刻正被闸门扣着。
    await expect.poll(async () => (await tabFrames()).at(-1)?.tabIds.length ?? 0,
      { message: '重启之后只有研究自己开的那一页（没有用户标签）' }).toBe(1);
    const researchTabId = (await tabFrames()).at(-1)?.tabIds[0];
    expect(researchTabId, '一帧 browser.tabsChanged 都没到：标签清单本身没被观测到').toMatch(TAB_ID);
    await expect.poll(async () => (await tabFrames()).at(-1)?.activeTabId ?? null).toBe(researchTabId);

    // 用户此刻才点开浏览器侧栏 —— 采集还在跑（第二行仍被闸门挡在那次导航上）。展开这一下就是
    // 失败的原始现场：研究那页是活动标签又被驱动，横幅出现；横幅收起时舞台长回去。
    // 每一次变化都是一次 `syncView` → `applyLayout` → 对每个标签（含研究那页）`applyViewport`。
    await launched.page.getByTestId('titlebar-browser').click();
    await expect(launched.page.locator('[data-pane="browser"]')).toBeVisible();
    const banner = launched.page.getByTestId('browser-agent-banner');
    await expect(banner, '研究那页是活动标签且正在被驱动：横幅出现（舞台因此矮一条横幅）').toBeVisible();
    const stageHeight = (): Promise<number> => launched.page.evaluate(() => {
      const stage = document.querySelector('[data-testid="browser-stage"]');
      if (!stage) throw new Error('browser stage missing');
      return stage.getBoundingClientRect().height;
    });
    const withBanner = await stageHeight();
    expect(withBanner).toBeGreaterThan(0);

    // 放行：导航落地 → 驱动帧收尾 → 横幅收起 → 舞台长回去。这一次 `applyViewport` 就落在
    // 第二行那次 collect 的 `prepareForDomRead` 前后（`applyLayout` 是 fire-and-forget 的）。
    expect(await releaseHeldQuery()).toContain('/search');
    await expect(banner).toHaveCount(0);
    // **这条判据只到「跳动发生过」这一层，先后顺序没有被钉住。** 要考的那条接缝钉在
    // `browserService.test.ts` 的 `viewport input mapping ACK` 三条用例里（只差 height 的已落地
    // 变化在 `measure` 两头都放过，`measure` 之后那一头由 `pointerGuard` 的命中测试兜住）；
    // 这里证明的是另一件事：跳动真实发生过（横幅收起 → 又一次 `syncView`），采集照旧把两行交给 wire。
    //
    // 为什么这里不断「跳动落在采集还在跑的时候」：在这个夹具里那两件事是**并发的** —— 横幅收起与
    // 采集收尾由同一个收尾时刻驱动，实测三遍里两遍跳动先到、一遍收尾先到。渲染层装记录器
    // （`ResizeObserver` + `xResearch.taskUpdated`）也只能记到跳动**画出来**那一刻的状态，滞后于
    // 真正的那一次 `syncView`，于是会把「跳动其实落在采集尾巴里」的情形判成「落在收尾之后」——
    // 一条会红的假阴性断言，比没有更糟。要真钉住先后，得让夹具在收尾之后还压着一份采集
    // （闸门目前只扣得住导航那一次，在跳动之前）。
    await expect.poll(stageHeight, { message: '横幅收起后舞台长回去了（高度变了 = 又一次 syncView）' })
      .not.toBe(withBanner);

    const waitRun = await run([call('x_research', { action: 'wait', researchRunId: restartRunId })]);
    const delivered = envelope(waitRun[0]);
    expect(delivered.deliveries).toHaveLength(1);
    const result = canonical(delivered.deliveries![0]!, submitRun[0].runId);
    if (result.operation !== 'search') throw new Error('search expected');
    // 判据是**结果**：两行都拿着 wire 夹具的那两条帖 —— 采集真的发生了，不是「没报错」。
    // 旧判据（`7ccd9d2`）下这里会是一个 `barrier.reason` 带 `input_not_delivered` 的失败行，
    // 而交付本身报成 `failed`（用户看到的是「源不可用」）。
    for (const row of result.queries) {
      expect(row.posts.map(post => post.text)).toEqual([WIRE_ROOT, WIRE_PLAIN]);
      expect(row).toMatchObject({ status: 'partial', stopReason: 'budget_reached', barrier: null });
      expect(row.collectionStop).toMatchObject({ status: 'partial', stopReason: 'budget_reached', reason: null });
    }
    expect(delivered.status).toBe('completed');
    expect(delivered.snapshot.counts).toMatchObject({ submissions: 1, done: 2, failed: 0, posts: 4 });
    expect(result.browserTabId).toBe(researchTabId);
  });

  test('one wait delivers three finished submissions of the run in submission order, and never twice', async () => {
    // R81c：20 目标的 read 让模型以为「20 次 wait」，于是它自己取消了研究。判据是协议事实：
    // 三段提交都收尾后，**一次** `wait` 的 `deliveries` 有三条，`undelivered` 为空。
    const firstRun = await run([call('x_research', {
      action: 'submit', ...searchArgs([FIRST_QUERY], BATCH_OBJECTIVE),
    })]);
    const first = envelope(firstRun[0]);
    const batchRunId = first.researchRunId;
    const secondRun = await run([
      call('x_research', { action: 'submit', researchRunId: batchRunId, ...searchArgs([FIRST_QUERY], BATCH_OBJECTIVE) }),
      call('x_research', { action: 'submit', researchRunId: batchRunId, ...searchArgs([FIRST_QUERY], BATCH_OBJECTIVE) }),
    ]);
    expect(secondRun.every(outcome => envelope(outcome).researchRunId === batchRunId)).toBe(true);

    const waited = envelope((await run([call('x_research', { action: 'wait', researchRunId: batchRunId })]))[0]);
    expect(waited.deliveries).toHaveLength(3);
    // 三段都收尾了：一条都不留在清单里，快照的计数也这么说。
    expect(waited.undelivered).toBeUndefined();
    expect(waited.snapshot.counts.undelivered).toBe(0);
    // 顺序是提交顺序：第一段来自上一轮，后两段来自这一轮的最后两次提交。
    // 结果的 `runId` 是**提交**那一轮（不是 `wait` 那一轮），三段各自对得上。
    const [firstDelivery, ...batchDeliveries] = waited.deliveries!;
    expect(canonical(firstDelivery!, firstRun[0].runId).operation).toBe('search');
    expect(batchDeliveries.map(delivery => delivery.result.runId))
      .toEqual([secondRun[0].runId, secondRun[1].runId]);
    expect(new Set(waited.deliveries!.map(delivery => delivery.submitCallId)).size).toBe(3);
    // 每条都是独立的一份结果：`callId` 与壳上的提交身份一致，正文来自 wire 夹具。
    for (const delivery of waited.deliveries!) {
      const result = canonical(delivery, delivery.result.runId);
      if (result.operation !== 'search') throw new Error('search expected');
      expect(result.queries[0]!.posts.map((post) => post.text)).toEqual([WIRE_ROOT, WIRE_PLAIN]);
    }

    // 正控：再 `wait` 一次，一条都不重复交付。
    const again = envelope((await run([call('x_research', { action: 'wait', researchRunId: batchRunId })]))[0]);
    expect(again.deliveries).toBeUndefined();
    expect(again.undelivered).toBeUndefined();
    expect(again.snapshot.counts.undelivered).toBe(0);
  });

  // ── 卡片级说法（Task 16）──
  //
  // 上面七条只看协议层。下面五条看的是渲染层真跑起来的那张卡：`data-status` 跟不跟着快照走、
  // 每一轮各说各的行数、一段研究会不会长出第二张卡、取消入口走不走确认、默认收放与手动点击谁说话算数、
  // 卡停在哪一条消息里（最后一条提到它的那条，后面还有不提它的消息时也一样）。
  // 判据全部是「DOM 上看得见的东西」或协议事实（`xResearch.taskGet` / 工具包络），没有时间窗。

  test('the card appears for a submit and shows every round with its own rows while the research runs', async () => {
    // **这里不预开用户页、也不展开侧栏**（R79）：那段绕法原本是为了让舞台不再跳动，而跳动的
    // 来源恰恰就是上一条要证明的路径（横幅为活动标签收放 → `applyLayout` 在采集进行中下发视口）。
    // 卡片这几条只读消息列里的 DOM，不点侧栏里的任何东西，所以它们不需要一个用户标签。
    // 重启恢复的每一段研究都各有一张卡（含 test 1 那段失败了的、test 5 那段被取消的）：
    // 「一段研究一张卡」在这条会话里从此刻起一直成立。
    await expectOneCardPerRun();
    const existing = await cardPlacement(LIFECYCLE_OBJECTIVE);
    expect(existing.cards, '这一段研究还没提交过，不该有卡').toBe(0);

    holdNextQuery(SECOND_QUERY.query);
    const submitRun = await run([call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY, SECOND_QUERY], LIFECYCLE_OBJECTIVE) })],
      undefined, 'the submit turn ended while the research was still running');
    const submitted = envelope(submitRun[0]);
    lifecycleRunId = submitted.researchRunId;
    lifecycleSubmitRunId = submitRun[0].runId;
    expect(submitted.status).toBe('running');
    const card = cardFor(LIFECYCLE_OBJECTIVE);
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-status', 'running');
    // 卡头说的是这一段研究的问题（R10：最早一次提交的那个，不是卡片自己编的）。
    await expect(card.getByTestId('x-research-objective')).toHaveText(LIFECYCLE_OBJECTIVE);
    // 运行中默认展开：搜索那一轮带着两个 query 各一行（提交那一刻就有的行，不是等收尾才算）。
    // 卡上不再有「搜索 / 读取」节标题：轮次头自己说操作与这一轮的行数。
    await expect(card.getByTestId('x-research-rows')).toBeVisible();
    const rounds = card.getByTestId('x-research-round');
    await expect(rounds).toHaveCount(1);
    await expect(rounds.nth(0)).toHaveAttribute('data-operation', 'search');
    await expect(rounds.nth(0)).toHaveText('第 1 轮 · 搜索 2 个 query');
    await expect(card.locator('[data-testid="x-research-row"][data-section="search"]')).toHaveCount(2);
    // 读取还没提交过：这一轮此刻不存在（「两轮各说各的行数」不能拿一轮冒充另一轮）。
    await expect(card.locator('[data-testid="x-research-round"][data-operation="read"]')).toHaveCount(0);
    await expectOneCardPerRun();

    // 同一段研究的第二次提交：卡头不换题（R10），两轮的行数各算各的。读取提交带的是自己的
    // objective，所以它是**第二个段**的第一轮 —— 轮号在段内从 1 起，不是接着搜索那一段数。
    const readRun = await run([call('x_research', { action: 'submit', researchRunId: submitted.researchRunId, ...readArgs(rootUrl) })]);
    expect(envelope(readRun[0]).snapshot.objective).toBe(LIFECYCLE_OBJECTIVE);
    await expect(card).toHaveAttribute('data-status', 'running');
    await expect(card.getByTestId('x-research-segment')).toHaveCount(2);
    await expect(rounds).toHaveCount(2);
    await expect(rounds.nth(0)).toHaveText('第 1 轮 · 搜索 2 个 query');
    await expect(rounds.nth(1)).toHaveAttribute('data-operation', 'read');
    await expect(rounds.nth(1)).toHaveText('第 1 轮 · 读取 1 个目标');
    await expect(card.locator('[data-testid="x-research-row"][data-section="search"]')).toHaveCount(2);
    await expect(card.locator('[data-testid="x-research-row"][data-section="read"]')).toHaveCount(1);
    // 两次提交是两轮、两条消息，卡只有一张，而且停在最后一条（也就是刚提到它的那条）里。
    await expectOneCardPerRun();
    await expectCardPlacement(LIFECYCLE_OBJECTIVE, '一段研究只有一张卡，且停在提到它的最后一条消息里',
      placed => placed.cards === 1 && placed.messageIndex === placed.lastIndex);
  });

  test('the card collapses and expands by hand, keeps that choice when the research finishes in place, and one wait does not add a second card', async () => {
    const card = cardFor(LIFECYCLE_OBJECTIVE);
    // 上一条把闸门扣在第二个 query 上：这一行还停在 `navigating`，研究还是运行的。
    await expect(card).toHaveAttribute('data-status', 'running');
    await expect(card.getByTestId('x-research-rows')).toBeVisible();

    // 手动收起 / 展开（运行中的默认是展开，所以收起这一下确实是点击说了算）。
    await card.getByTestId('x-research-toggle').click();
    await expect(card.getByTestId('x-research-rows')).toHaveCount(0);
    await card.getByTestId('x-research-toggle').click();
    await expect(card.getByTestId('x-research-rows')).toBeVisible();

    // 放行闸门里的那次导航：两段自己跑完，**没有新的一轮**（卡不换消息、不重建）。
    // 这里的 15s 是夹具那几次采集的预算（两次导航 + 一次读取），不是给断言放宽的余地。
    expect(await releaseHeldQuery()).toContain('/search');
    await expect(card).toHaveAttribute('data-status', 'completed', { timeout: 15_000 });
    // 终态的默认是收起，但手动展开过：用户的点击优先 —— 行还在（重建的话就会消失）。
    await expect(card.getByTestId('x-research-rows')).toBeVisible();
    expect((await taskGet(lifecycleRunId)).state).toBe('completed');

    const waitRun = await run([call('x_research', { action: 'wait', researchRunId: lifecycleRunId })]);
    const delivered = envelope(waitRun[0]);
    // 这一段研究的两份提交都收尾了：一次 `wait` 两条一起交（R81c）。
    expect(delivered.deliveries).toHaveLength(2);
    const searchDelivery = delivered.deliveries!.find(delivery => delivery.operation === 'search');
    const readDelivery = delivered.deliveries!.find(delivery => delivery.operation === 'read');
    if (!searchDelivery || !readDelivery) throw new Error('both submissions must be delivered');
    const result = canonical(searchDelivery, lifecycleSubmitRunId);
    if (result.operation !== 'search') throw new Error('search expected');
    expect(result.queries.map(row => row.status)).toEqual(['partial', 'partial']);
    expect(readDelivery.result.runId).toBeTruthy();
    expect(delivered.snapshot.counts).toMatchObject({ submissions: 2, searchDone: 2, searchTotal: 2,
      readDone: 1, readTotal: 1, undelivered: 0 });
    expect(delivered.undelivered).toBeUndefined();
    // 交付完这一份，卡仍是那一段研究的唯一一张，停在新的一条消息里，状态还是完成。
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-status', 'completed');
    await expectOneCardPerRun();
    await expectCardPlacement(LIFECYCLE_OBJECTIVE, '交付后仍是那一张卡，且停在新的一条消息里',
      placed => placed.cards === 1 && placed.messageIndex === placed.lastIndex);
    // 新消息里是新建的卡（没有手动选择）：终态默认收起。
    await expect(card.getByTestId('x-research-rows')).toHaveCount(0);
  });

  test('cancelling from the card goes through the confirm dialog once and settles every segment of the turn', async () => {
    // 同一回合里两段新研究：第一段占住队列（第二个 query 被闸住 ⇒ 它在真导航），第二段真的**排队**着。
    // 按 R81b 它们是一张卡的两个分段；取消按钮因此确认一次、把这一段回合里还在排队/进行中的都停下。
    holdNextQuery(SECOND_QUERY.query);
    const queueRun = await run([
      call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY, SECOND_QUERY], OCCUPANT_OBJECTIVE) }),
      call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY], CANCEL_OBJECTIVE) }),
    ], undefined, 'the submit turn ended while the research was still queued');
    const occupant = envelope(queueRun[0]);
    const doomed = envelope(queueRun[1]);
    expect(occupant.researchRunId).not.toBe(doomed.researchRunId);
    expect(queueRun[0].runId).toBe(queueRun[1].runId);
    expect(doomed.status).toBe('running');
    await expectOneCardPerRun();

    // 两段研究是**一张**卡：卡头取最早一段的目标（R10），分段头两行。
    const card = cardFor(OCCUPANT_OBJECTIVE);
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-status', 'running');
    await expect(card.getByTestId('x-research-rows')).toBeVisible();
    await expect(card.getByTestId('x-research-segment')).toHaveCount(2);
    await expect(card.locator('[data-testid="x-research-row"][data-section="search"]')).toHaveCount(3);
    const cancel = card.getByTestId('x-research-cancel');
    await expect(cancel).toBeVisible();

    // ① 取消要先问：对话框是这张卡的，取消掉就什么都不该发生。
    await cancel.click();
    const dialog = launched.page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('取消这段 X 研究？');
    await expect(dialog.getByTestId('confirm-dialog-confirm')).toHaveText('取消研究');
    await launched.page.getByTestId('confirm-dialog-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(card).toHaveAttribute('data-status', 'running');
    await expect(cancel).toBeVisible();
    // 卡与协议两边都得说「没动过」：卡上一个「运行中」而服务里已经取消过，是两个事实各说各的。
    const declined = await taskGet(doomed.researchRunId);
    expect(declined.state).toBe('running');
    expect(declined.counts).toMatchObject({ submissions: 1, queued: 1, cancelled: 0 });
    expect((await taskGet(occupant.researchRunId)).state).toBe('running');

    // ② 确认：两段都在协议里取消（不是卡上画出来的），卡进「取消」终态。
    await cancel.click();
    await expect(dialog).toBeVisible();
    await launched.page.getByTestId('confirm-dialog-confirm').click();
    await expect(card).toHaveAttribute('data-status', 'cancelled');
    await expect.poll(async () => [
      (await taskGet(occupant.researchRunId)).state,
      (await taskGet(doomed.researchRunId)).state,
    ]).toEqual(['cancelled', 'cancelled']);
    // 终态默认收起（这一张从未被手动点过），分段头跟着行一起收起来。
    await expect(card.getByTestId('x-research-rows')).toHaveCount(0);
    // 展开之后两段各自说取消：「用户按的」不是无主语的「被取消」（R81a 的归因落在段上）。
    await card.getByTestId('x-research-toggle').click();
    const segments = card.getByTestId('x-research-segment');
    await expect(segments).toHaveCount(2);
    await expect(segments.nth(0)).toContainText('你中途取消');
    await expect(segments.nth(1)).toContainText('你中途取消');

    // 取消一个回合不动别的回合里已经交付过的那段研究：它仍是完成。
    await expect(cardFor(LIFECYCLE_OBJECTIVE)).toHaveAttribute('data-status', 'completed');
    // 放行闸门里那份响应（取消可能已经让它被放弃，那就不在手上）——别留到 afterAll。
    await releaseHeldQuery();
    await expectOneCardPerRun();
  });

  test('a cancelled research and its retry submitted later in the same turn are one card with two segments', async () => {
    // 现场那三张卡的成因（R81）：一个回合里取消 → 重开 → 重试。这里在**同一个回合**里复现：
    // 第一段提交后闸门扣住它的导航，回合中途用户从卡上取消它；第二段（重试）在同一回合里后到
    // （`afterMs` 是夹具的节奏，不是断言的等待）。两段研究的 `runId` 相同 ⇒ 一张卡、两个分段头。
    holdNextQuery(SECOND_QUERY.query);
    const retryRun = await run([
      call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY, SECOND_QUERY], RETRY_OBJECTIVE) }),
      { ...call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY], RETRY_AFTER_CANCEL_OBJECTIVE) }),
        afterMs: 5000 },
    ], async () => {
      const card = cardFor(RETRY_OBJECTIVE);
      await expect(card).toHaveAttribute('data-status', 'running');
      await expect.poll(() => gate.held.map(entry => new URL(entry.url).pathname)).toEqual(['/search']);
      await card.getByTestId('x-research-cancel').click();
      const dialog = launched.page.getByTestId('confirm-dialog');
      await expect(dialog).toBeVisible();
      await launched.page.getByTestId('confirm-dialog-confirm').click();
      // 此刻回合里只有第一段研究：取消只停它。
      await expect(card).toHaveAttribute('data-status', 'cancelled');
    }, 'the submit turn ended while the retry was still queued');
    const first = envelope(retryRun[0]);
    const retry = envelope(retryRun[1]);
    expect(first.researchRunId).not.toBe(retry.researchRunId);
    // 同一回合：分组键（创建回合的 runId）相同，这正是它们并成一张卡的依据。
    expect(retryRun[0].runId).toBe(retryRun[1].runId);

    // 放行被取消那段还挂着的响应，让重试那一段自己跑完（闸门是夹具事件，重试的 query 不被扣）。
    await releaseHeldQuery();
    await expect.poll(async () => (await taskGet(retry.researchRunId)).state,
      { message: 'the retry research finishes on its own', timeout: 15_000 }).toBe('completed');
    expect((await taskGet(first.researchRunId)).state).toBe('cancelled');

    // 一张卡、两个分段头：① 被取消的那段（用户按的）② 重试成功的那段；卡头仍是最早一段的目标。
    const card = cardFor(RETRY_OBJECTIVE);
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId('x-research-objective')).toHaveText(RETRY_OBJECTIVE);
    await expect(card).toHaveAttribute('data-status', 'cancelled');
    // 终态默认收起：展开才看得见两个分段头（它们属于行那一段，不是卡头）。
    await card.getByTestId('x-research-toggle').click();
    const segments = card.getByTestId('x-research-segment');
    await expect(segments).toHaveCount(2);
    await expect(segments.nth(0)).toHaveAttribute('data-status', 'cancelled');
    await expect(segments.nth(1)).toHaveAttribute('data-status', 'completed');
    await expect(segments.nth(0)).toContainText('你中途取消');
    await expect(segments.nth(1)).toContainText(RETRY_AFTER_CANCEL_OBJECTIVE);
    await expectOneCardPerRun();
  });

  test('cancelling a research that is actually navigating ends cancelled, not completed', async () => {
    // 采集层的取消形状是**返回**一份每行 `status: 'cancelled'` 的结果，不是抛错（spec §4.7）：
    // 只看行数的收尾会把它写成 `done`，卡上读成「完成（部分被取消）」。这里让取消落在一次**真导航**上
    // （闸门扣着第二个 query 的响应），于是「这一轮确实跑完了」与「它被用户取消了」同时为真 ——
    // 只有停下来的原因能分辨它们，行数分辨不了。
    holdNextQuery(SECOND_QUERY.query);
    const submitRun = await run([call('x_research', {
      action: 'submit', ...searchArgs([FIRST_QUERY, SECOND_QUERY], NAVIGATING_CANCEL_OBJECTIVE),
    })], undefined, 'the submit turn ended while the research was still running');
    const submitted = envelope(submitRun[0]);
    const card = cardFor(NAVIGATING_CANCEL_OBJECTIVE);
    await expect(card).toHaveAttribute('data-status', 'running');
    // 正向证明它在**导航**，不是排着队：代理里确实躺着一次 `/search` 请求（协议事实，不是时间窗）。
    await expect.poll(() => gate.held.map(entry => new URL(entry.url).pathname)).toEqual(['/search']);
    // 第一行已经收尾（撞预算），第二行还在导航：取消要落在**真导航**上，这正是闸门扣着的那一条。
    await expect.poll(async () => (await taskGet(submitted.researchRunId)).search.map(row => row.state))
      .toEqual(['stopped', 'navigating']);

    await card.getByTestId('x-research-cancel').click();
    const dialog = launched.page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await launched.page.getByTestId('confirm-dialog-confirm').click();
    // 卡片与协议两边都得说「取消」：卡上画一个词而服务里是 `completed` 是两个事实各说各的。
    await expect(card).toHaveAttribute('data-status', 'cancelled');
    expect((await taskGet(submitted.researchRunId)).state).toBe('cancelled');
    // 收尾：闸门里那份响应可能还挂着（客户端未必立刻放弃一条被取消的导航）——放掉它，
    // 别把一份没人要的响应留到 afterAll。放行之后它落到一张已经没有采集在等的页上，无害。
    await releaseHeldQuery();
    await expectOneCardPerRun();
  });

  test('the card stays on the message that mentioned it when a later message does not', async () => {
    // 上一条那一轮提交了两段新研究（占队列的与要取消的），那一条助手消息**没提到** lifecycle 这段：
    // 卡必须留在它最后被提到的那一条里 —— `messageIndex < lastIndex`。
    // 上面两处 `messageIndex === lastIndex` 在「永远画在最新消息上」的实现上也成立（那时它恰好
    // 就是最新一条），只有这一条能把它判红。
    await expectCardPlacement(LIFECYCLE_OBJECTIVE,
      '后面的消息不提这段研究时，卡仍停在提到它的那条里（不是永远画在最新一条上）',
      placed => placed.cards === 1 && placed.messageIndex >= 0 && placed.messageIndex < placed.lastIndex);
  });

  test('one research submitted twice shows a round header per submission, in submit order', async () => {
    // 用户看到的断层（R82）：一段研究跑了四次提交，卡把行全摊成两个列表，看不出模型在首次采集之后
    // 又补跑了几轮。判据是行自己的 `submissionId`（协议事实）：同一份提交的行带同一个 id，卡按它
    // 切轮 —— 不是时间窗、不是阈值。
    // 闸门扣住第二个 query 的导航：第一份提交停在 `navigating`，卡是运行中（默认展开）、
    // 第二份提交排在它后面但**行已经计划好**（提交那一刻就在快照里）。
    holdNextQuery(SECOND_QUERY.query);
    const firstRun = await run([call('x_research', { action: 'submit',
      ...searchArgs([FIRST_QUERY, SECOND_QUERY], ROUNDS_OBJECTIVE) })],
    undefined, 'the submit turn ended while the research was still running');
    const created = envelope(firstRun[0]);
    const card = cardFor(ROUNDS_OBJECTIVE);
    await expect(card).toHaveAttribute('data-status', 'running');
    await expect(card.getByTestId('x-research-rows')).toBeVisible();

    // 同一段研究的第二份提交（一个 query）：这就是卡上的「第 2 轮」。
    const secondRun = await run([call('x_research', { action: 'submit',
      researchRunId: created.researchRunId, ...searchArgs([FIRST_QUERY], ROUNDS_OBJECTIVE) })]);
    expect(envelope(secondRun[0]).snapshot.counts.submissions).toBe(2);
    // 协议里确实是两份提交：三行的 `submissionId` 只有两个值，前两行属于第一份。
    const protocol = await taskGet(created.researchRunId);
    expect(new Set(protocol.search.map(row => row.submissionId)).size).toBe(2);
    expect(protocol.search.map(row => row.submissionId)).toEqual([
      protocol.search[0]!.submissionId, protocol.search[0]!.submissionId, protocol.search[2]!.submissionId,
    ]);

    // 卡上：两个轮次头，各自说这一轮带出来几项；第一轮说 query 数，第二轮说「补搜」。
    const rounds = card.getByTestId('x-research-round');
    await expect(rounds).toHaveCount(2);
    await expect(rounds.nth(0)).toHaveAttribute('data-operation', 'search');
    await expect(rounds.nth(0)).toHaveAttribute('data-round', '1');
    await expect(rounds.nth(0)).toHaveText('第 1 轮 · 搜索 2 个 query');
    await expect(rounds.nth(1)).toHaveAttribute('data-operation', 'search');
    await expect(rounds.nth(1)).toHaveAttribute('data-round', '2');
    await expect(rounds.nth(1)).toHaveText('第 2 轮 · 补搜 1 个 query');
    // 行还是三行，编号在段内连续（第二轮接着 ③，不从 ① 重来）。
    const searchRows = card.locator('[data-testid="x-research-row"][data-section="search"]');
    await expect(searchRows).toHaveCount(3);
    await expect(searchRows.nth(0)).toContainText('①');
    await expect(searchRows.nth(2)).toContainText('③');
    await expect(searchRows.nth(2)).toContainText(FIRST_QUERY.query);

    // 收尾：放行闸门里那份响应（下一轮提交还要在这条链上跑），别把它留到 afterAll。
    await releaseHeldQuery();
    await expectOneCardPerRun();
  });

  test('a cancelled round and the round that continues it are one card, one segment, two rounds', async () => {
    // R83：取消停的是**这一轮**，不是整段研究。用户按取消之后模型接着提交同一个目标 —— 这是同一段
    // 研究的新一轮，不是一段新研究，所以卡上不该多出一段「残骸」：一张卡、一个分段、两个轮次头，
    // 第一轮带着「已取消」。判据全是协议事实（`xResearch.taskGet` 的 `rounds`）与 DOM 上的字。
    holdNextQuery(SECOND_QUERY.query);
    const firstRun = await run([call('x_research', { action: 'submit',
      ...searchArgs([FIRST_QUERY, SECOND_QUERY], CONTINUE_OBJECTIVE) })],
    undefined, 'the submit turn ended while the research was still running');
    const first = envelope(firstRun[0]);
    const card = cardFor(CONTINUE_OBJECTIVE);
    await expect(card).toHaveAttribute('data-status', 'running');
    // 正向证明它在**导航**（取消有东西可停）：代理里确实躺着一次 `/search` 请求。
    await expect.poll(() => gate.held.map(entry => new URL(entry.url).pathname)).toEqual(['/search']);
    await card.getByTestId('x-research-cancel').click();
    const dialog = launched.page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    await launched.page.getByTestId('confirm-dialog-confirm').click();
    await expect(card).toHaveAttribute('data-status', 'cancelled');
    // 协议里那一轮是取消的，带主语（用户按的，R81a）。
    const stoppedRounds = (await taskGet(first.researchRunId)).rounds!;
    expect(stoppedRounds).toHaveLength(1);
    expect(stoppedRounds[0]).toMatchObject({ state: 'cancelled', cancelledBy: 'user' });

    // 同一个 `researchRunId`、同一个 objective 接着提交：这是新一轮，真会跑。
    const second = envelope((await run([call('x_research', {
      action: 'submit', researchRunId: first.researchRunId, ...searchArgs([FIRST_QUERY], CONTINUE_OBJECTIVE),
    })]))[0]);
    expect(second.researchRunId).toBe(first.researchRunId);
    // 提交那一刻就回到进行中：取消没有把研究钉死（这一份排在链上，`queued` 也是真的活）。
    expect(second.snapshot).toMatchObject({ state: 'running' });
    expect(second.snapshot.rounds!.map(round => round.state)).toEqual(['cancelled', 'queued']);
    // 放行闸门里那份响应（被取消的那一轮可能已经放弃了它，那时它不在手上）—— 别留到 afterAll。
    await releaseHeldQuery();
    await expect.poll(async () => (await taskGet(first.researchRunId)).state,
      { message: 'the round submitted after the cancel runs on its own', timeout: 15_000 }).toBe('completed');

    // 一张卡、**一段**（同一个目标）、两个轮次头：第一轮带章，第二轮说它是补搜。
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-status', 'completed');
    await expect(card.getByTestId('x-research-objective')).toHaveText(CONTINUE_OBJECTIVE);
    await card.getByTestId('x-research-toggle').click();
    const segments = card.getByTestId('x-research-segment');
    await expect(segments).toHaveCount(1);
    // 段的终态按**轮**算：一轮取消 + 一轮完成 = 完成（取消的是其中一轮，不是这一段）。
    await expect(segments.nth(0)).toHaveAttribute('data-status', 'completed');
    await expect(segments.nth(0)).toContainText(CONTINUE_OBJECTIVE);
    const rounds = card.getByTestId('x-research-round');
    await expect(rounds).toHaveCount(2);
    await expect(rounds.nth(0)).toHaveAttribute('data-round', '1');
    await expect(rounds.nth(0)).toHaveText('第 1 轮 · 搜索 2 个 query已取消（你中途取消）');
    await expect(rounds.nth(1)).toHaveAttribute('data-round', '2');
    await expect(rounds.nth(1)).toHaveText('第 2 轮 · 补搜 1 个 query');
    // 三行都在。取消只落在**在飞的那一条**上：第一行在点击前就撞预算收尾了，守住它自己的结论；
    // 被闸门扣住的那一行才是被取消的（两件事各说各的，不是「整轮一起翻成取消」）。
    const searchRows = card.locator('[data-testid="x-research-row"][data-section="search"]');
    await expect(searchRows).toHaveCount(3);
    await expect(searchRows.nth(0)).toContainText(FIRST_QUERY.query);
    await expect(searchRows.nth(0)).toContainText('采集 2 帖');
    await expect(searchRows.nth(1)).toContainText('已取消');
    await expect(searchRows.nth(2)).toContainText(FIRST_QUERY.query);
    await expectOneCardPerRun();
  });
});
