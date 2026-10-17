/**
 * `x_research` 改成动作面之后，63 只证明**协议层**（控制器裁决 R58）：`submit` 立即返回、工作活在
 * 回合之后、`wait` 一次交付一份、`xResearch.taskGet` 说的是真实状态、真重启之后状态与计数还在、
 * `cancel` 只收尾它自己那一段。卡片级断言（`data-status`、两段行数）属 Task 16，这里一条都不碰。
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
 * 一次启动跑完全部说法（`serial`），中间只有一次真重启（进程 pid 会变，见最后一条）。
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

type Call = { name: string; args: Record<string, unknown>; toolCallId: string };
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
      ...calls.map(c => ({ ...c, type: 'tool', after_ms: 0 })),
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
    const rows = parsed.delivery
      ? parsed.delivery.operation === 'search'
        ? (parsed.delivery.result as Extract<XResearchResult, { operation: 'search' }>).queries.map(q => ({ status: q.status, stopReason: q.stopReason, posts: q.posts.map(p => p.postId) }))
        : (parsed.delivery.result as Extract<XResearchResult, { operation: 'read' }>).targets.map(t => ({ status: t.status, stopReason: t.stopReason, root: t.root?.postId ?? null }))
      : null;
    console.info('[x-envelope]', JSON.stringify({ action: parsed.action, researchRunId: parsed.researchRunId,
      status: parsed.status, counts: parsed.snapshot.counts, undelivered: parsed.undelivered,
      delivery: parsed.delivery ? { submissionId: parsed.delivery.submissionId, submitCallId: parsed.delivery.submitCallId, operation: parsed.delivery.operation, rows } : null }));
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

  const searchArgs = (queries: readonly (typeof FIRST_QUERY | typeof SECOND_QUERY)[]) => ({
    search: { objective: OBJECTIVE, queries, maxPostsPerQuery: 3, maxScrollsPerQuery: 0 },
  });
  const readArgs = (url: string) => ({
    read: { objective: READ_OBJECTIVE, targets: [{ url }], includeArticle: false, includeReplies: false,
      maxScrollsPerPost: 0, maxExpandActionsPerPost: 0 },
  });

  test('an unauthenticated research delivers the auth barrier as row status; a native fixture login clears it', async () => {
    const submitRun = await run([call('x_research', { action: 'submit', ...searchArgs([FIRST_QUERY, SECOND_QUERY]) })]);
    const submitted = envelope(submitRun[0]);
    expect(submitted.action).toBe('submit');
    expect(submitted.status).toBe('running');
    // submit 不带交付、wait 带：同一条用例里两种形状都在，`delivery` 这个字段确实会出现在壳上。
    expect(submitted.delivery).toBeUndefined();
    const authRun = await run([call('x_research', { action: 'wait', researchRunId: submitted.researchRunId })]);
    const delivered = envelope(authRun[0]);
    expect(delivered.delivery).toBeTruthy();
    const result = canonical(delivered.delivery!, submitRun[0].runId);
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
    // 研究在闸门窗口里开了自己的页（提交那一刻两行都还在排队，开页发生在 `run.ended` 之后）。
    // 活动标签却还得是用户那一页。先证明研究那张标签真的被广播过（「基线里没有的 id」只能来自
    // 研究自己开页的那一帧，否则下面那条就是「什么都没观测到」），再证明基线之后每一帧说的
    // 活动标签都只有用户那一页。（`browser.getState` 也读得到 `activeTabId`，但它每调一次就换
    // epoch，会把侧栏静音 —— 见文件头。）
    await expect.poll(researchTabsSinceUserTab,
      { message: 'the research opened its own tab (a tab id that is not in the baseline frame)' }).not.toHaveLength(0);
    const researchTabIds = await researchTabsSinceUserTab();
    expect(await activeTabsSinceUserTab(), `the research's tab ${researchTabIds.join(',')} must not become the active tab`).toEqual([userTabId]);
    // 闸门里躺着第二个 query 的那次导航 —— 正向证明这一行「到了、没拿到页面」，不是「从没试过」。
    await expect.poll(() => gate.held.map(entry => new URL(entry.url).pathname)).toEqual(['/search']);
    expect(new URL(gate.held[0].url).searchParams.get('q')).toBe(SECOND_QUERY.query);
    await expect.poll(async () => (await taskGet(researchRunId)).search.map(
      row => ({ label: row.label, state: row.state, posts: row.posts, scrolls: row.scrolls, pages: row.pages })))
      .toEqual([
        { label: FIRST_QUERY.query, state: 'collecting', posts: 2, scrolls: 0, pages: 1 },
        { label: SECOND_QUERY.query, state: 'navigating', posts: 0, scrolls: 0, pages: 0 },
      ]);
    const heldWindow = await taskGet(researchRunId);
    expect(heldWindow.state).toBe('running');
    expect(heldWindow.objective).toBe(OBJECTIVE);
    // 这里不断 `budget`：每个夹具都把 `maxScrollsPerQuery` 声明成 0，而快照里的 `budget` 是
    // 各次提交**声明值**的累加（xResearchTask 的 `budget.scrolls += submission.budget.scrolls`），
    // 于是那条断言是「零的和等于零」—— 恒真（R59b）。真实数额在下面这几桶里：
    // `running` 是两行都还没收尾，`posts` 是 wire 夹具已服务的那两条。
    expect(heldWindow.counts).toMatchObject({ submissions: 1, queued: 0, running: 2, done: 0, posts: 2, undelivered: 0 });
  });

  test('releasing the held navigation lets one wait deliver exactly one canonical result', async () => {
    expect(await releaseHeldQuery()).toContain('/search');
    const waitRun = await run([call('x_research', { action: 'wait', researchRunId })]);
    const delivered = envelope(waitRun[0]);
    expect(delivered.action).toBe('wait');
    expect(delivered.delivery).toBeTruthy();
    const delivery = delivered.delivery!;
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

  test('a second submission appends to the same research and one wait delivers one result while listing the rest', async () => {
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
    expect(delivered.delivery!.operation).toBe('search');
    canonical(delivered.delivery!, outcomes[0].runId);
    // 一次 wait 只交一份：读取那份已经收尾，进清单不进这一轮的交付。
    expect(delivered.undelivered).toHaveLength(1);
    expect(delivered.undelivered![0]).toMatchObject({ operation: 'read', state: 'done', objective: READ_OBJECTIVE });
    expect(delivered.snapshot.counts).toMatchObject({ submissions: 3, done: 4, undelivered: 1, posts: 6 });
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
    // 取消是唯一的控制：一段被取消的研究不能被追加工作（静默复活）。
    expect(cancelledRun[1].status).toBe('failed');
    expect(cancelledRun[1].text).toContain('cancelled');
    expect((await taskGet(queued.researchRunId)).state).toBe('cancelled');

    // 放行占住队列的那一段：它照常交付自己的结果，被取消的那一段跟它无关。
    expect(await releaseHeldQuery()).toContain('/search');
    const occupyingWait = envelope((await run([call('x_research', { action: 'wait', researchRunId: occupying.researchRunId })]))[0]);
    expect(occupyingWait.delivery).toBeTruthy();
    expect(occupyingWait.snapshot.state).toBe('completed');
    const occupyingResult = canonical(occupyingWait.delivery!, occupyingRun[0].runId);
    if (occupyingResult.operation !== 'search') throw new Error('search expected');
    expect(occupyingResult.queries.map(row => row.status)).toEqual(['partial', 'partial']);

    // 主研究里早就收尾、一直没交付的那份还在：取消别人不会让它消失。
    expect((await taskGet(researchRunId)).state).toBe('completed');
    const pendingRun = await run([call('x_research', { action: 'submit', researchRunId, ...searchArgs([FIRST_QUERY]) })]);
    expect(pendingRun[0].status).toBe('ok');
    pendingSubmitRunId = pendingRun[0].runId;
    const retrieved = envelope((await run([call('x_research', { action: 'wait', researchRunId })]))[0]);
    expect(retrieved.delivery!.operation).toBe('read');
    const readResult = canonical(retrieved.delivery!, readSubmitRunId);
    if (readResult.operation !== 'read') throw new Error('read expected');
    expect(readResult.targets[0]).toMatchObject({ status: 'observed', root: { postId: '321', text: WIRE_ROOT, sourceUrl: rootUrl } });
    // 交出去的只是最早那一份未交付：刚提交的那份仍在清单里（重启那一条要交付的正是它）。
    expect(retrieved.undelivered).toHaveLength(1);
    expect(retrieved.undelivered![0]).toMatchObject({ operation: 'search', state: 'done', objective: OBJECTIVE });
    expect(retrieved.snapshot.counts).toMatchObject({ submissions: 4, done: 5, undelivered: 1, posts: 8 });

    // 这一段研究从头到尾（闸门那一次、追加的两次、被取消那一段）自己开了页、导航、交付，
    // 而活动标签一次都没被它抢走。两条断合起来才是这条性质：
    // ①此后确实还有研究自己开的新标签（观测量是活的，不是没观测到东西）；
    // ②这些帧说的活动标签永远是用户那一页（`browserService.open` 里 `activate === true` 只有
    //   用户自己在地址栏那条路才传，研究侧 `xResearchBrowser.open` 传的是 false）。
    const laterResearchTabs = await researchTabsSinceUserTab();
    expect(laterResearchTabs, 'the research opened tabs after the baseline').not.toHaveLength(0);
    expect(await activeTabsSinceUserTab(), `research tabs ${laterResearchTabs.join(',')} must not become the active tab`).toEqual([userTabId]);
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
    expect(delivered.delivery).toBeTruthy();
    const delivery = delivered.delivery!;
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
});
