import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage, type LaunchedApp } from './helpers';

/**
 * 内置浏览器（slowpaper 一期）的 e2e。spec §8.2 + `e2e-requirements.md`。
 *
 * ## 为什么这一组必须打真源
 *
 * `urlGuard` 只放行 **公网** http/https：`localhost`、`127.0.0.1`、私网段、
 * `.local` / `.internal` 全部拒绝（`urlGuard.ts` 的 `isLocalHostname` /
 * `isPrivateIPv4`）。所以**起不了本地夹具服务器** —— 内置浏览器里能打开的页面
 * 只能来自真正的公网。受控的页面内容因此靠「先打开一个真页面，再往它里面注入」
 * 拿到（每条用例自己注入自己要的那点 DOM）。
 *
 * 发版流水线上 runner 是机房 IP，真源随时会当它是机器人；所以 `KYDOG_SKIP_LIVE_BROWSER=1`
 * 跳过整组，**跳过原因带在用例上**（照 `src/test-support/symlinkCapability.ts` 的
 * 现成做法，不是静默绿）。本机默认跑。
 *
 * ## 断言为什么全在主进程里做
 *
 * `WebContentsView` 是原生层，宿主 window 的 DOM 与像素里都没有它 ——
 * Playwright 的 `page` 够不着。断言一律走 `app.evaluate`（主进程）→
 * `webContents.getAllWebContents()` 找到那个 view → 在页面里求值。
 * **不加任何只在 KYDOG_E2E 下注册的测试入口**（spec §8.2）。
 *
 * ## 工具那几条怎么走到（`KYDOG_AGENT_FIXTURE` 的 `tool` 事件）
 *
 * E-1a / E-1b / E-4 与 spec §8.2 第 2 条要动的是 `browserService.dispatch /
 * snapshot / evalInPage` 与 `browserTools.runStep` —— 它们在生产代码里唯一的调用方
 * 是 `createBrowserTools()` 交出去的那四个工具的 `execute`。`app.evaluate` 够不着
 * 它们（`.vite/build/main.js` 是 rollup 出来的 CJS 单体 bundle，对外只导出七个符号，
 * `browserService` 不在其中），而 spec §8.2 明令**不许加测试专用 RPC**。
 *
 * 走的是**既有夹具机制**：`KYDOG_AGENT_FIXTURE` 的 `ask` 事件一直就是**真调**
 * `askUserQuestionTool.execute`；这一轮把它补齐成「按名字执行任意一个已注册的工具」
 * （`fixtureProvider.ts` 的 `tool` 事件）。`sessionFactory` 里 `createBrowserTools()`
 * 现在**造在分支之前，两条路共用同一份** —— 所以这里跑到的 `execute` 就是
 * 非 fixture 分支交给 pi 的那一个，`enqueue` → `withAgentDriving` → `dispatch` /
 * `evalInPage` 整条产品路径一步不少。**没有加任何 RPC，也没有任何只在
 * `KYDOG_E2E` 下注册的入口。**
 *
 * 工具结果从**渲染层**读回来（`run.tool_call_chunk` 是它的正常出口，与用户在工具卡
 * 里展开看到的是同一份字节）—— E-1b 要量的正是「真实工具结果的字节数」。
 */

const SKIP_LIVE = process.env.KYDOG_SKIP_LIVE_BROWSER === '1';
const SKIP_REASON =
  'KYDOG_SKIP_LIVE_BROWSER=1：这一组要打真源。内置浏览器的 urlGuard 只放行公网 http/https，'
  + '起不了本地夹具服务器；而发版流水线的 runner 是机房 IP，真源会把它当机器人。'
  + '本机默认跑 —— 不跑就等于这一批一行都没验过。';

/** 逻辑视口宽（`browserService.ts` 的 `LOGICAL_WIDTH`）。两边各写一个字面量就是两份会漂的真相，
 *  但 e2e 不能 import 主进程模块，所以这里写死并在断言的失败信息里点名出处。 */
const LOGICAL_WIDTH = 1280;
/** 侧栏没打开时的逻辑视口高（`browserService.ts` 的 `DEFAULT_VIEWPORT_HEIGHT`）。同上。 */
const DEFAULT_VIEWPORT_HEIGHT = 800;
/** walker 跑的隔离世界号（`browserService.ts` 的 `WALKER_WORLD_ID`）。同上。 */
const WALKER_WORLD_ID = 31337;
/** 网页内容块的收尾标记（`snapshot.ts` 的 `PAGE_CONTENT_CLOSE`）。同上：写死并在失败信息里点名出处。 */
const PAGE_CONTENT_CLOSE = '──── 网页内容结束 ────';

/** 采集脚本的**生产源码本身**。`browserService` 用 `?raw` 注入的就是这一份字节。 */
const WALKER_SOURCE = readFileSync(
  path.resolve(__dirname, '../src/main/browser/injected/walker.js'), 'utf8',
);

/** walker 报回来的一行（`walker.js` 的 `collect`）。 */
type WalkerNode = { index: number; nodeId: number; role: string; name: string; w: number; h: number };
type WalkerResult = { generation: string; url: string; title: string; nodes: WalkerNode[] };

/**
 * 在**内置浏览器的那个页面**里求值（主世界）。
 *
 * 按 URL 认那个 webContents：宿主窗口是 `file://…/index.html`，内置浏览器的 view 是
 * http(s)。**认不到唯一一个就抛**，并把当时所有 webContents 的 URL 带出来 ——
 * 静默挑第一个的话，一条本该红的用例会在一个错误的页面上悄悄变绿。
 */
async function inPage<T>(app: ElectronApplication, needle: string, expr: string): Promise<T> {
  const r = await app.evaluate(async ({ webContents }, a) => {
    const all = webContents.getAllWebContents().filter((w) => !w.isDestroyed());
    const hits = all.filter((w) => w.getURL().includes(a.needle));
    if (hits.length !== 1) return { ok: false as const, urls: all.map((w) => w.getURL()) };
    return { ok: true as const, value: (await hits[0].executeJavaScript(a.expr)) as unknown };
  }, { needle, expr });
  if (!r.ok) {
    throw new Error(`主进程里没有唯一一个 URL 含「${needle}」的 webContents，实际有：${JSON.stringify(r.urls)}`);
  }
  return r.value as T;
}

/** 那个页面此刻的逻辑视口。`browserService.applyViewport` 下发的 `Emulation` 覆盖就落在这两个数上。 */
function viewport(app: ElectronApplication, needle: string): Promise<{ w: number; h: number }> {
  return inPage(app, needle, '({ w: window.innerWidth, h: window.innerHeight })');
}

/** 打开侧栏，等它真的挂上来（`[data-pane="browser"]` 与舞台都在了才算）。 */
async function openSidebar(page: Page): Promise<void> {
  await page.getByTestId('titlebar-browser').click();
  await expect(page.locator('[data-pane="browser"]')).toBeVisible();
  await expect(page.getByTestId('browser-stage')).toBeVisible();
}

/** 从渲染层走生产那条 RPC 开一个标签（`ownerRunId` 被主进程强制成 null，是「用户的」标签）。 */
function openTab(page: Page, url: string, tabId?: string) {
  return page.evaluate(
    (a) => window.kydog.invoke('browser.open', a.tabId ? { url: a.url, tabId: a.tabId } : { url: a.url }),
    { url, tabId },
  );
}

// ── 走真工具那一路（fixture 的 `tool` 事件）────────────────────────────────────

/**
 * 一次工具调用。`name` 必须是 `createBrowserTools()` 里那四个之一。
 *
 * `afterMs` 是 fixture 自己的节拍（`FixtureEvent.after_ms`），用在「上一次调用返回之后
 * 还得再等一会儿才看得到结果」的地方 —— CARSI 那条正是：SAML 断言回传发生在
 * `browser_login` 早就返回之后。
 */
type ToolCall = { toolCallId: string; name: string; args: Record<string, unknown>; afterMs?: number };

/**
 * 把若干次工具调用包成一份 fixture 剧本。
 *
 * 前后那几条不是装饰：`AgentService` 的工具事件处理**要求有 `activeMessageId`**
 * （`toolMessageId` 回 null 就整条丢掉，只在日志里留一行），而它由 `message_start`
 * 建立。少了它这一批会静默地什么都不发生 —— 断言拿不到结果，而原因看不出来。
 */
function toolScript(calls: ToolCall[]) {
  return {
    events: [
      { after_ms: 5, type: 'agent_start' },
      { after_ms: 5, type: 'message_start', messageId: 'm1' },
      ...calls.map(({ afterMs, ...c }) => ({ after_ms: afterMs ?? 5, type: 'tool', ...c })),
      {
        after_ms: 5, type: 'message_end', messageId: 'm1',
        toolCallIds: calls.map((c) => c.toolCallId),
        toolNames: calls.map((c) => c.name),
      },
      { after_ms: 5, type: 'agent_end', reason: 'completed' },
    ],
  };
}

/**
 * 起一个**接得上 agent** 的实例：有项目、有 thread 可建，且 `KYDOG_AGENT_FIXTURE`
 * 指向一份**待写**的剧本。
 *
 * 剧本故意留到用例里再写：`browser_open` 之外的三个工具都要一个 `tabId`，而它由
 * `browserService.createTab` 现铸（`tab_<uuid 前 8 位>`），启动时根本不存在。
 * `createFixtureSession` 是在**建 thread 那一刻**才 `readFile` 的，所以只要在点
 * 「新对话」之前把文件写好就行 —— 不需要在 fixture 里发明任何占位符语法。
 */
async function launchWithAgent(): Promise<{ launched: LaunchedApp; fixturePath: string }> {
  const projectPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const fixtureDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kydog-fixture-'));
  const fixturePath = path.join(fixtureDir, 'browser-tools.json');
  const launched = await launchKydog({
    fixture: fixturePath,
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  return { launched, fixturePath };
}

/** 一次工具调用的结果：渲染层收到的原样字节 + 终态。 */
type ToolOutcome = { text: string; status: 'ok' | 'failed' };

/**
 * 写好剧本、建 thread、发一句，等这一轮跑完，把每次工具调用的结果收回来。
 *
 * 结果读的是**渲染层收到的 `run.tool_call_chunk`** —— 那是工具结果对用户的正常出口
 * （工具卡展开看到的就是这一份字节），不是为测试另开的窗口。E-1b 要量的
 * 「真实工具结果的字节数」量的就是它。
 *
 * `duringRun` 在发出去之后、等收场之前跑：`browser_login` 那道首次确认是一次**跨进程
 * 悬挂**（走的是现成的 ask broker），不在这中间答一下，这一轮永远不会结束。
 * 返回值这里不用（写成 `unknown` 而不是 `void`，好让调用方顺手把中途看到的东西带出去 ——
 * `confirmLoginPage` 带出来的就是那道确认点名的 host）。
 */
async function runTools(
  page: Page, fixturePath: string, calls: ToolCall[],
  duringRun?: (page: Page) => Promise<unknown>,
): Promise<Map<string, ToolOutcome>> {
  await fsp.writeFile(fixturePath, JSON.stringify(toolScript(calls), null, 2));
  // 收集器要挂在**建 thread 之前**：事件一到就得有人接着，补不回来。
  await page.evaluate(() => {
    const w = window as unknown as { __kydogRun?: unknown };
    const box = {
      chunks: [] as Array<{ toolCallId: string; chunk: string }>,
      ends: [] as Array<{ toolCallId: string; status: string }>,
      ended: null as null | { reason: string; errorMessage?: string },
    };
    w.__kydogRun = box;
    window.kydog.on('run.tool_call_chunk', (p) => box.chunks.push({ toolCallId: p.toolCallId, chunk: p.chunk }));
    window.kydog.on('run.tool_call_end', (p) => box.ends.push({ toolCallId: p.toolCallId, status: p.status }));
    window.kydog.on('run.ended', (p) => { box.ended = { reason: p.reason, errorMessage: p.errorMessage }; });
  });

  await page.getByTestId('new-thread').click();
  await page.getByTestId('composer-input').fill('按剧本跑一次浏览器工具');
  await page.getByTestId('send-button').click();
  if (duringRun) await duringRun(page);

  type Box ={ chunks: Array<{ toolCallId: string; chunk: string }>; ends: Array<{ toolCallId: string; status: string }>; ended: null | { reason: string; errorMessage?: string } };
  const read = () => page.evaluate(() => (window as unknown as { __kydogRun: Box }).__kydogRun);
  // 工具那一步是真的在操作网页（导航 / 抽取 / 收尾快照），比纯 fixture 的一轮慢得多，
  // 所以这里给的是**基础设施预算**，不是行为判据 —— 判据全在下面各条断言上。
  await expect.poll(async () => (await read()).ended, {
    timeout: 60_000,
    message: '这一轮 run 应当跑完（fixture 的 agent_end）；一直是 null 说明工具那一步卡住了',
  }).not.toBe(null);
  const box = await read();
  expect(box.ended?.reason, `这一轮不该以 ${box.ended?.reason} 收场：${box.ended?.errorMessage ?? ''}`)
    .toBe('completed');

  const out = new Map<string, ToolOutcome>();
  for (const c of calls) {
    const text = box.chunks.filter((x) => x.toolCallId === c.toolCallId).map((x) => x.chunk).join('');
    const end = box.ends.find((x) => x.toolCallId === c.toolCallId);
    expect(end, `工具 ${c.name}（${c.toolCallId}）一条 run.tool_call_end 都没发出来 —— `
      + 'fixture 的 tool 事件没走到真工具，或者 AgentService 把它丢了').toBeTruthy();
    out.set(c.toolCallId, { text, status: (end!.status as 'ok' | 'failed') });
  }
  return out;
}

// ── CARSI 那两条（spec §8.2 第 5、6 条）────────────────────────────────────────

/**
 * 凭据**从环境变量种进临时 HOME**。`helpers.ts` 每次 `mkdtemp` 一个新 HOME，
 * 本机设置不在被测进程视野里 —— 所以不种就一定跑不了，这是好事：
 * 「忘了配」不会变成「拿开发者本人的校园账号去撞 IdP」。
 */
const CARSI = {
  name: process.env.KYDOG_CARSI_NAME ?? '',
  entityID: process.env.KYDOG_CARSI_ENTITY_ID ?? '',
  username: process.env.KYDOG_CARSI_USERNAME ?? '',
  password: process.env.KYDOG_CARSI_PASSWORD ?? '',
  /** 本校统一身份认证页的完整地址（就是模型会导过去的那个）。 */
  loginUrl: process.env.KYDOG_CARSI_LOGIN_URL ?? '',
};
/** 身份那四项（**不含真密码**）。反路那条只要这四项 —— 见 `CARSI_FAILURE_ON`。 */
const CARSI_IDENTITY_READY = [CARSI.name, CARSI.entityID, CARSI.username, CARSI.loginUrl]
  .every((v) => v !== '');
const CARSI_READY = CARSI_IDENTITY_READY && CARSI.password !== '';

/**
 * 正路那条：`KYDOG_CARSI_E2E=1` **且**五个凭据变量齐全才跑。
 *
 * 它也不是无害的 —— 每跑一次就是一次真的机构登录。所以同样要显式开。
 */
const CARSI_ON = process.env.KYDOG_CARSI_E2E === '1' && CARSI_READY;

/**
 * 反路那条：**单独一个环境变量**，与正路那条分开。
 *
 * 理由是这条用例的性质：**每跑一次就是一次故意的登录失败**，而高校 IdP 普遍锁定
 * 连续失败的账号 —— 押的是用户自己的校园账号。所以它不跟着 `KYDOG_CARSI_E2E` 走，
 * 必须再点一次头（还要另给一个明确写错的密码，不许由用例自己拿真密码拼一个）。
 *
 * **它要的是身份那四项，不含 `KYDOG_CARSI_PASSWORD`。** 这条用例内部对真密码零引用
 * （种进设置的是 `KYDOG_CARSI_BAD_PASSWORD`），从前却把 `CARSI_READY` 整个当前提 ——
 * 等于逼用户为一条一个字都不用真密码的用例把真密码放进环境。少一份暴露面就少一份。
 */
const CARSI_FAILURE_ON = process.env.KYDOG_CARSI_FAILURE_E2E === '1'
  && CARSI_IDENTITY_READY && (process.env.KYDOG_CARSI_BAD_PASSWORD ?? '') !== '';

/**
 * 一个 http(s) 网址的 host，归一规则与 `login.ts` 的 `hostOfEntityID` /
 * `urlGuard.ts` 的 `normalizeHost` 逐字相同（小写、剥掉根标签的尾点；
 * URN / 非 http(s) / 空主机一律 `null`）。entityID 与 `KYDOG_CARSI_LOGIN_URL`
 * 都从这里过一遍 —— 两边各写一套归一就是两份会漂的真相。
 *
 * e2e 不 import 主进程模块，所以这里现算一份并在失败信息里点名出处。
 * **但它与 `LOGICAL_WIDTH` / `DEFAULT_VIEWPORT_HEIGHT` / `PAGE_CONTENT_CLOSE`
 * 那几份复制常量不是一回事**：那几份由每次 `npm run e2e` 必跑的用例守着，漂了当场红；
 * 这一份只服务 CARSI 那两条，**要有真凭据才武装得起来**，平时一次都跑不到。
 * 真正接住「产品侧改了归一规则」的是第一道：`login.test.ts` 有两条专门守归一的用例
 * （复审 M-γ 实测：把 `login.ts` 的 `normalizeHost` 拿掉，`npm test` 当场红 2），
 * 走不到 e2e 这一层。所以别在别处把这份复制当成「有人守着」的例子引用。
 *
 * 为什么正路那条要拿 entityID 的 host 去比，而不是 `KYDOG_CARSI_LOGIN_URL` 的 host：
 * `checkLoginHost` 判「这确实是本校的登录页」用的就是 entityID 的 host，
 * 而 `browser_login` 回显的 `r.host` 是**填之前现读的标签地址**。拿 loginUrl 的 host 去比
 * 等于拿配置对配置 —— 用例自己就是 `openTab(page, CARSI.loginUrl)` 打开的这个标签，
 * 没跳转时两边必然相等。（loginUrl 的 host 在那条用例里另有用处：它只用来**分流**
 * 同域 / 跨域两条一等路径，不当判据。见那里。）
 */
function hostOfHttpUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase().replace(/\.+$/, '');
  return h === '' ? null : h;
}

const CARSI_SKIP_REASON =
  'CARSI 正路默认不跑：要 KYDOG_CARSI_E2E=1 外加 KYDOG_CARSI_NAME / _ENTITY_ID / '
  + '_USERNAME / _PASSWORD / _LOGIN_URL 五个凭据变量（临时 HOME 里没有它们就一定跑不了）。'
  + '每跑一次都是一次真的机构登录。';
const CARSI_FAILURE_SKIP_REASON =
  'CARSI 反路默认不跑，而且**与正路分开**开关：要 KYDOG_CARSI_FAILURE_E2E=1 外加'
  + ' KYDOG_CARSI_BAD_PASSWORD，以及身份那四项（NAME / ENTITY_ID / USERNAME / LOGIN_URL）——'
  + '**不含 KYDOG_CARSI_PASSWORD**，这条用例一个字都不用真密码。'
  + '每跑一次就是一次故意的登录失败，而高校 IdP 普遍锁定'
  + '连续失败的账号 —— 押的是用户自己的校园账号。';

/** `confirmLoginPage` 看到的东西：问没问过、那道确认点名的是哪个 host。 */
type LoginConfirmSeen = {
  /** 这一轮到底弹没弹那道是非题。**两种都是正常形态**，见下面 docblock。 */
  asked: boolean;
  /** 「是」那一项点名的 host（`loginConfirm.ts` 的 `确认 X 是本校的登录页`）。没问过 → null。 */
  host: string | null;
};

/**
 * 首次确认那道是非题（`loginConfirm.ts`）：走的是现成的 ask broker，UI 与提问工具同一套。
 *
 * **「问了」与「没问」两种情形都要走得通，而且都不许靠等满时限来分辨。**
 * `checkLoginHost`（`login.ts`）那份判据表里，**第 1 条与第 3 条都是正常判据**：
 * 当前标签的 host === entityID 的 host → 直接 `fill`、根本不问；host 不同 →
 * `confirm-then-fill`，问一次并记住。也就是说「entityID 在 `idp.x.edu.cn`、
 * 登录页在 `passport.x.edu.cn`」的学校是产品**明确支持**的形态，不是配错了。
 * 从前这里硬等 30 秒 `question-composer`，于是这条正路用例**只在跨域那一支上跑得过**：
 * 同域的学校拿真凭据跑它，会挂在那 30 秒上、红在一个与产品完全无关的理由上。
 * （这条用例一次都没跑过，第一次跑就会踩。）
 *
 * 所以这里在两件事之间轮询，谁先到听谁的：是非题出现了 → 点「是」；这一轮 run 已经
 * 收场了 → 说明根本没问，直接返回。**答不答得上不能靠猜**：那道是非题会把整轮 run
 * 悬挂住（走的是跨进程的 ask broker），不答就永远不结束。
 *
 * **返回的 host 取自「是」那一项的 description**（`确认 X 是本校的登录页`），
 * **不取题面** —— 题面里带着账号（`loginConfirm.ts` 刻意让它只到用户屏幕为止），
 * 别让它有机会进断言、失败信息或 CI 日志。正路那条用例拿这个 host 去断
 * 「用户确认的那个 host 就是最终填进去的那个」。
 *
 * **这里替用户点了「是」，于是 `checkLoginHost` 那道域确认在这条用例上不设防** ——
 * 测这条路必然的代价。代价的边界由正路用例里那三条断言划出（见那里）。
 */
async function confirmLoginPage(page: Page): Promise<LoginConfirmSeen> {
  const composer = page.getByTestId('question-composer');
  const deadline = Date.now() + 30_000;
  let asked = false;
  while (Date.now() < deadline) {
    if (await composer.isVisible()) { asked = true; break; }
    // `runTools` 在**建 thread 之前**就把收集器挂上了，所以这里读得到；
    // `ended` 非 null 就是这一轮已经收场 —— 没问过，没什么可确认的。
    const ended = await page.evaluate(
      () => (window as unknown as { __kydogRun?: { ended: unknown } }).__kydogRun?.ended ?? null,
    );
    if (ended !== null) break;
    await page.waitForTimeout(200);
  }
  // 两种正常情形都从这里出去。真卡住的话不在这里报 —— 交给 `runTools` 那条 60 秒的
  // `expect.poll`，它会说清「这一轮 run 卡住了」，比这里编一个原因准。
  //
  // **这句话有一个前提，别把它拆了**：两个调用方都 `test.setTimeout(180_000)`，
  // 所以上面这 30 秒加那条 poll 的 60 秒（合计 ~90s）装得进用例预算。
  // 本机实测同一个 30s+60s 结构的两个分支（2026-09-09，临时探针）：
  //  · 180s 预算 → **1.5m** 红，Call Log 是「Timeout 60000ms exceeded while waiting on
  //    the predicate」—— poll 自己到点，那句话真说得出口；
  //  · `playwright.config.ts` 的默认 60s 预算 → **58.9s** 红，Call Log 变成
  //    「Test timeout of 60000ms exceeded」—— 先到的是用例的墙，poll 永远走不完。
  // 所以谁把上面那两条 `test.setTimeout(180_000)` 拿掉、或者把这个 helper 挪进一条
  // 没有它的用例，这里的诊断就退化成一条时间墙。要缩的话缩这 30 秒，别缩预算。
  if (!asked) return { asked: false, host: null };
  // 第一个选项就是「是，就在这里登录」——`loginConfirm.ts` **结构地**取 options[0]，
  // 这里按同一个顺序点，不写死文案。
  const yes = page.getByTestId('ask-option-q0o0');
  // 点之前先把它点名的 host 读出来 —— 点完提交，这道题就从 DOM 上没了。
  const host = (await yes.innerText()).match(/确认 (\S+?) 是本校的登录页/)?.[1] ?? null;
  await yes.click();
  const submit = page.getByTestId('ask-submit');
  if (await submit.count()) await submit.click();
  await expect(composer).toHaveCount(0, { timeout: 10_000 });
  return { asked: true, host };
}

// **跳过不许是静默的。** `test.skip(cond, reason)` 把原因记成注解，可 list reporter
// 只画一个 `-`，原因要点开 HTML / JSON 报告才看得见 —— 而流水线上没人会去点。
// 所以这里再往运行输出里写一行：谁看日志谁就看得到这一组为什么没跑。
// （不写死条数：这一组还在长，一个会漂的数字比没有数字更糟。）
if (SKIP_LIVE) console.warn(`\n[61-browser] describe 里的用例整组跳过：${SKIP_REASON}\n`);

test.describe('61-browser', () => {
  test.skip(SKIP_LIVE, SKIP_REASON);

  /**
   * spec §8.2 第 1 条（S1b 的回归）。**`setZoomFactor` 会失败的正是这里** ——
   * 它按 host 存在 session 的 HostZoomMap 里，跨 host 导航就没了。
   *
   * 两件事一起断言，缺一条都会变成一条不会红的用例：
   *  · **几何真的变了** —— 拖动之后逻辑视口高必须跟着变（`height = bounds.height / scale`，
   *    而 `scale = 侧栏宽 / 1280`）。不断言这一条的话，「拖拽根本没生效」与
   *    「宽度被正确钉住」长得一模一样，`innerWidth` 恒 1280 是白给的。
   *  · **逻辑宽一动不动** —— 拖动后、以及跨 host 再导航一次之后，都还是 1280。
   */
  test('拖动侧栏宽度、跨 host 再导航一次，逻辑视口宽恒为 1280', async () => {
    const launched = await launchKydog();
    const { app, page } = launched;
    try {
      await openSidebar(page);
      await openTab(page, 'https://example.com/');

      // 侧栏的几何落到页面上（逻辑高不再是「没有舞台」那一档的 800）之后再取基线。
      await expect.poll(
        async () => (await viewport(app, 'example.com')).h,
        { message: '侧栏打开后 syncView 应当把舞台几何下发到页面上' },
      ).not.toBe(DEFAULT_VIEWPORT_HEIGHT);
      const before = await viewport(app, 'example.com');
      expect(before.w, '侧栏刚打开时逻辑宽就该是 1280').toBe(LOGICAL_WIDTH);

      // 右侧分栏手柄往右拖 = 把侧栏拖窄（ThreeColumnLayout 的 `side === 'right'`：
      // `setWidth(startW - dx)`）。默认 560，拖 120 之后约 440，仍在 MIN_BROWSER_WIDTH(320) 之上。
      const paneWidth = async () => (await page.locator('[data-pane="browser"]').boundingBox())!.width;
      const paneBefore = await paneWidth();
      const handle = page.getByTestId('resize-right');
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 12 });
      await page.mouse.up();

      // 侧栏真的窄了（DOM 侧的事实），再看页面侧。
      await expect.poll(
        paneWidth,
        { message: '拖动之后侧栏应该真的变窄了；没变的话下面那条 1280 是白给的' },
      ).toBeLessThan(paneBefore - 60);

      await expect.poll(
        async () => (await viewport(app, 'example.com')).h,
        { message: '侧栏变窄 → scale 变小 → 逻辑视口高必须跟着变大；不变说明这次拖拽压根没下发到页面' },
      ).not.toBe(before.h);

      const afterDrag = await viewport(app, 'example.com');
      expect(afterDrag.w, '拖动侧栏宽度之后逻辑视口宽仍必须是 1280').toBe(LOGICAL_WIDTH);

      // 跨 host 再导航一次 —— setZoomFactor 那条路正是死在这里。
      const st = await page.evaluate(() => window.kydog.invoke('browser.getState'));
      const tabId = st.tabs[0].id;
      await openTab(page, 'https://example.org/', tabId);
      const afterNav = await viewport(app, 'example.org');
      expect(afterNav.w, '跨 host 导航之后逻辑视口宽仍必须是 1280（HostZoomMap 那条路会死在这里）')
        .toBe(LOGICAL_WIDTH);
      expect(afterNav.h, '跨 host 之后侧栏几何还是刚才那一份，逻辑高应当与导航前一致').toBe(afterDrag.h);
    } finally {
      await teardown(launched);
    }
  });

  /**
   * spec §8.2 第 3 条。渲染层重载后：标签还在、URL 没变、**页面没有重新加载**。
   *
   * 「页面没重新加载」用页面里种的一个计数器验证 —— 只看标签清单的话，
   * 一个「重载时把每个标签重新 loadURL 一遍」的实现照样全绿，而那正好会丢掉
   * 登录会话与半填的表单。
   */
  test('渲染层重载：标签仍在、URL 未变、页面没有重新加载', async () => {
    const launched = await launchKydog();
    const { app, page } = launched;
    try {
      await openSidebar(page);
      const opened = await openTab(page, 'https://example.com/');
      const tabId = opened.tabId;

      // 页面里种一个只可能在「文档被换掉」时消失的东西。
      const planted = await inPage<number>(app, 'example.com',
        '(window.__kydogE2E = (window.__kydogE2E || 0) + 1)');
      expect(planted).toBe(1);

      await page.reload();
      await page.locator('[data-pane="workspace"], [data-testid="onboarding-root"]').first().waitFor();

      const st = await page.evaluate(() => window.kydog.invoke('browser.getState'));
      expect(st.tabs.map((t) => t.id), '重载之后标签清单必须一模一样').toEqual([tabId]);
      expect(st.tabs[0].url, '重载之后 URL 不许变').toBe('https://example.com/');

      const after = await inPage<number>(app, 'example.com', 'window.__kydogE2E ?? null');
      expect(after, '重载之后页面里种的计数器必须还在（还是 1）—— 变成 null 说明文档被重新加载了')
        .toBe(1);
    } finally {
      await teardown(launched);
    }
  });

  /**
   * `e2e-requirements.md` E-2：**侧栏没打开时，浏览器行为与打开时一致**
   * （项目负责人裁决：「没开侧栏也按开过侧栏操作。它打不打开，都是一样。」）
   *
   * 这条依赖的浏览器行为此前只有 Task 2f 的一次性脚本量过（`task-2f-report.md` §B3），
   * 从来没有进过回归网，而项目有明确约定：浏览器行为的断言不许以肯定句下结论、
   * 要真的量。这条用例就是那次量本身。
   *
   * 判据取的正是 `applyViewport` 那段注释里实测过的失败形态：**百分比宽度的元素**
   * 在没有 bounds 时会塌到 min-content（50% 宽的 button 量到 16px），进而被 walker 的
   * `visible()` 滤掉，快照变成一片空白。所以断言 50% 宽的元素量到 640。
   * 只断言 `innerWidth === 1280` 是不够的 —— 那个数在布局塌掉时照样成立。
   */
  test('侧栏从没打开过：页面照样按 1280 逻辑宽布局，百分比宽度的元素不塌', async () => {
    const launched = await launchKydog();
    const { app, page } = launched;
    try {
      // **一次 syncView 都不发**：侧栏根本没挂上来。
      await expect(page.locator('[data-pane="browser"]')).toHaveCount(0);
      await expect(page.getByTestId('browser-stage')).toHaveCount(0);

      await openTab(page, 'https://example.com/');

      const vp = await viewport(app, 'example.com');
      expect(vp.w, '侧栏没打开时逻辑视口宽仍必须是 1280').toBe(LOGICAL_WIDTH);
      expect(vp.h, '侧栏没打开时逻辑视口高是 DEFAULT_VIEWPORT_HEIGHT').toBe(DEFAULT_VIEWPORT_HEIGHT);

      const rect = await inPage<{ w: number; h: number }>(app, 'example.com', `(() => {
        const d = document.createElement('div');
        d.style.cssText = 'position:absolute;left:0;top:0;width:50%;height:40px';
        document.body.appendChild(d);
        const r = d.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })()`);
      expect(rect.w, '50% 宽的元素必须量到 640（塌成 min-content 的话 walker 会把整页滤空）')
        .toBe(LOGICAL_WIDTH / 2);
      expect(rect.h, '高度也必须是真的，不是 0').toBe(40);
    } finally {
      await teardown(launched);
    }
  });

  /**
   * `e2e-requirements.md` E-1a 的**前提**：隔离世界真的骗不到。
   *
   * **先说清这条守的是什么、不守什么。** 它守的是「walker 跑在隔离世界里就看得到真结构」
   * 这条 2026-09-08 spike 量过一次、此后从没进过回归网的浏览器事实（Chromium 升级
   * 改了隔离世界语义的话，这条会红）。它**不**守
   * 「`browserService.snapshot` 调的是 `executeJavaScriptInIsolatedWorld` 而不是
   * `executeJavaScript`」—— 那个入口在 e2e 里够不到（见文件头），世界号是这条用例
   * 自己指定的。那半由 `browserTools.test.ts` 的替身用例钉着。
   *
   * 两侧一起断言，否则这条用例是白给的：主世界那一次**必须真的被骗到**，
   * 才说明覆写生效了；只跑隔离世界那一次的话，一个「覆写压根没装上」的环境也全绿。
   */
  test('页面覆写 document.querySelectorAll：主世界被骗到，隔离世界看到真结构', async () => {
    const launched = await launchKydog();
    const { app, page } = launched;
    try {
      await openTab(page, 'https://example.com/');

      // 真链接与伪造链接都真的挂进 DOM（伪造那个要可见，否则它连主世界那一次都进不了
      // 快照，「被骗到」就无从观察）。然后把 querySelectorAll 换成只回伪造那一个。
      await inPage(app, 'example.com', `(() => {
        const mk = (id, text) => {
          const a = document.createElement('a');
          a.id = id; a.href = 'https://example.net/' + id; a.textContent = text;
          a.style.cssText = 'position:absolute;left:0;display:block;width:200px;height:40px';
          document.body.appendChild(a);
          return a;
        };
        mk('kydog-real', 'KYDOG真实链接');
        const fake = mk('kydog-fake', 'KYDOG伪造的结果行');
        const rigged = [fake];
        const patched = function () { return rigged; };
        document.querySelectorAll = patched;
        Document.prototype.querySelectorAll = patched;
        Element.prototype.querySelectorAll = patched;
        return true;
      })()`);

      const run = await app.evaluate(async ({ webContents }, a) => {
        const wc = webContents.getAllWebContents()
          .filter((w) => !w.isDestroyed() && w.getURL().includes('example.com'));
        if (wc.length !== 1) throw new Error('找不到唯一一个内置浏览器的 webContents');
        const isolated = await wc[0].executeJavaScriptInIsolatedWorld(a.world, [{ code: a.src }]);
        const main = await wc[0].executeJavaScript(a.src);
        return { isolated, main } as { isolated: unknown; main: unknown };
      }, { world: WALKER_WORLD_ID, src: WALKER_SOURCE });

      const names = (r: unknown) => (r as WalkerResult).nodes.map((n) => n.name).join(' | ');
      const mainNames = names(run.main);
      const isoNames = names(run.isolated);

      // 对照组：覆写确实生效了 —— 主世界只看得到伪造的那一行。
      expect(mainNames, '主世界跑 walker 必须被覆写骗到（看到伪造行）；没被骗到说明覆写压根没装上，'
        + '下面隔离世界那条就是白给的').toContain('KYDOG伪造的结果行');
      expect(mainNames, '主世界被骗到时不该看得到真链接').not.toContain('KYDOG真实链接');

      // 正题：同一份 walker 源码在隔离世界里看到的是真 DOM。
      expect(isoNames, '隔离世界里 walker 必须看到真结构（真链接在）').toContain('KYDOG真实链接');
    } finally {
      await teardown(launched);
    }
  });

  /**
   * `e2e-requirements.md` E-3：**大页面上的采集成本**。
   *
   * 第四批把遍历改成了 `document.querySelectorAll('*')`（为了找到 shadow 宿主）。
   * 上界（`MAX_WALKED = 80000`）加在「其后每个元素的工作量」上，而**物化 NodeList
   * 那一步本身没有上界**，实现者明确登记「未在真实大页面上实测过」。
   * 原始失败场景：几万节点的大目录页把渲染进程阻塞数秒，而执行侧没有超时，
   * `browser_open` 只能干等。
   *
   * 这里造的是 walker 自己 docblock 里那份成本表的**最坏形态**：全 `<input>`
   * （遍历里那次密码登记每个元素都走到底）且 `visibility:hidden`
   * （rect 早退那条路走不到，`getComputedStyle` 每个都真跑）。节点数取 12 万，
   * 越过 `MAX_WALKED` 那道闸 —— 闸后面还有 4 万个节点只参与物化、不参与遍历，
   * 量的正是「物化那一步有没有上界」这件事。
   *
   * 上界 1500ms 的依据（**这三个数是 2026-09-09 在本条用例里实测的**，不是估的）：
   *  · 现在这样（MAX_WALKED = 80000 那道闸在）：**251ms**
   *  · 把两道闸都拆掉、12 万个元素每个都量 rect + style：**301ms**
   *  · Task 2f 用 CDP 单量 walker 本体：95.6ms（10 万节点）/ 105.6ms（20 万节点）
   * 这里的数比 2f 大，多出来的是 `executeJavaScriptInIsolatedWorld` 这一次
   * 主进程 ↔ 渲染进程往返 —— 计时刻意罩着它，因为 `browser_open` 真正要干等的就是这一段。
   * 1500ms ≈ 6 倍余量：它要抓的是原始失败场景里「阻塞数秒」那一档，不是几十毫秒的抖动。
   */
  test('十二万节点的大页面：采集脚本必须在 1.5 秒内返回', async () => {
    test.setTimeout(120_000);
    const launched = await launchKydog();
    const { app, page } = launched;
    try {
      await openTab(page, 'https://example.com/');

      const built = await inPage<number>(app, 'example.com', `(() => {
        const box = document.createElement('div');
        box.style.cssText = 'visibility:hidden';
        box.innerHTML = new Array(120000).fill('<input type="text">').join('');
        document.body.appendChild(box);
        // 先结算一次 layout，别把建树的账算到采集头上。
        void document.body.offsetHeight;
        return document.querySelectorAll('*').length;
      })()`);
      expect(built, '大页面没造出来的话下面那个耗时不说明任何事').toBeGreaterThan(120_000);

      const timed = await app.evaluate(async ({ webContents }, a) => {
        const wc = webContents.getAllWebContents()
          .filter((w) => !w.isDestroyed() && w.getURL().includes('example.com'));
        if (wc.length !== 1) throw new Error('找不到唯一一个内置浏览器的 webContents');
        const t0 = Date.now();
        const r = await wc[0].executeJavaScriptInIsolatedWorld(a.world, [{ code: a.src }]);
        return { ms: Date.now() - t0, result: r as unknown };
      }, { world: WALKER_WORLD_ID, src: WALKER_SOURCE });

      const res = timed.result as WalkerResult & { collection: { truncated: boolean; limit?: string } };
      expect(
        timed.ms,
        `采集 ${built} 个节点的页面花了 ${timed.ms}ms。慢的是隔离世界里那段 walker（含 `
        + `querySelectorAll('*') 物化整棵树 + MAX_WALKED 之内每个元素的 rect/style），`
        + '不是主进程也不是 IPC —— 计时只罩着 executeJavaScriptInIsolatedWorld 这一次调用。',
      ).toBeLessThan(1500);
      expect(res.collection.limit, '12 万节点必须撞到 MAX_WALKED 那道闸；没撞到说明这一页没造对')
        .toBe('walked');
    } finally {
      await teardown(launched);
    }
  });

  /**
   * `e2e-requirements.md` **E-1a**：extract 必须跑在隔离世界 —— 这一条走的是
   * **真的 `browser_act` 工具**（`runStep` 的 extract 分支 → `browserService.evalInPage`），
   * 不是自己指定世界号注一份脚本。
   *
   * 上面那条「主世界被骗到 / 隔离世界看到真结构」守的是浏览器事实；这一条守的是
   * **真页面上生产代码到底被骗到没有**。
   *
   * **2026-09-09 重新量过那次变异**（把 `browserService.evalOn` 的
   * `executeJavaScriptInIsolatedWorld` 改回 `executeJavaScript`）：`tsc` 干净、
   * `lint` exit 0 **且一条警告都没有**（`WALKER_WORLD_ID` 别处还在用），
   * 而 `npm test` **红了 50 条**（`browserService.test.ts` 上一轮补的那批替身用例）。
   * 所以 `e2e-requirements.md` 里「三条 gate 全拦不住」那句话**现在已经不成立** ——
   * 它记的是那批替身用例补上之前的状态。
   *
   * 那这条 e2e 还守什么：替身只知道我们**调了哪个入口**，不知道那个入口在真 Chromium 里
   * **真的**骗不到。这一条量的是后者，而且量的是整条产品路径（工具 → browserService →
   * 真页面）。同一次变异下它给出的红是：工具结果里出现了「KYDOG伪造论文」。
   *
   * 骗局的形状是关键：伪造行**故意不匹配真选择器**（class 是 `kydog-fake-row`，
   * 而抽取的 item 是 `.kydog-row`），只有被覆写的 `document.querySelectorAll`
   * 才会把它交出来。所以：
   *  · 隔离世界（正确）→ 只看得到两条真行，伪造行**根本不会出现**；
   *  · 主世界（回退）→ 只看得到伪造那一行。
   * 两种结果没有任何重叠，判据不靠字数也不靠顺序。
   *
   * 对照组照旧在用例内部：覆写必须**真的装上了**（主世界那一次只看得到伪造行），
   * 否则下面那条是白给的。
   */
  test('走真的 extract 工具：页面覆写 querySelectorAll 骗不到它，抽到的是真结构', async () => {
    const { launched, fixturePath } = await launchWithAgent();
    const { app, page } = launched;
    try {
      // **不开侧栏**：E-2 那条已经量过「开不开都一样」，而 1024 宽的窗口里再挂一个
      // 560 宽的侧栏会把中栏挤到 composer 不可见 —— 那是窗口尺寸的事，不是被测行为。
      const opened = await openTab(page, 'https://example.com/');

      await inPage(app, 'example.com', `(() => {
        const mk = (cls, id, title) => {
          const row = document.createElement('div');
          row.className = cls; row.id = id;
          row.style.cssText = 'position:relative;width:400px;height:30px';
          const t = document.createElement('span');
          t.className = 'kydog-t'; t.textContent = title;
          row.appendChild(t);
          document.body.appendChild(row);
          return row;
        };
        mk('kydog-row', 'r1', 'KYDOG真论文一');
        mk('kydog-row', 'r2', 'KYDOG真论文二');
        // 伪造行不带 kydog-row —— 真的 querySelectorAll('.kydog-row') 永远选不到它。
        const fake = mk('kydog-fake-row', 'rf', 'KYDOG伪造论文');
        const rigged = [fake];
        const patched = function () { return rigged; };
        document.querySelectorAll = patched;
        Document.prototype.querySelectorAll = patched;
        return true;
      })()`);

      // 对照组：覆写真的生效了。这三行与 extractExpression 的核心逐字同形
      // （`document.querySelectorAll(item)` → 每个 `el.querySelector(field)`）。
      const fooled = await inPage<string[]>(app, 'example.com', `(() => {
        const out = [];
        for (const el of document.querySelectorAll('.kydog-row')) {
          const t = el.querySelector('.kydog-t');
          out.push(t ? (t.innerText || '').trim() : null);
        }
        return out;
      })()`);
      expect(fooled, '主世界跑同一份选择器必须被骗到（只看得到伪造行）；没被骗到说明覆写压根没装上，'
        + '下面那条就是白给的').toEqual(['KYDOG伪造论文']);

      const res = await runTools(page, fixturePath, [{
        toolCallId: 'tc-extract',
        name: 'browser_act',
        args: {
          tabId: opened.tabId,
          actions: [{ kind: 'extract', selectors: { item: '.kydog-row', title: '.kydog-t' } }],
        },
      }]);
      const out = res.get('tc-extract')!;
      expect(out.status, `browser_act 应当成功，实际结果：${out.text.slice(0, 400)}`).toBe('ok');
      expect(out.text, 'extract 必须看到真结构（真论文一）').toContain('KYDOG真论文一');
      expect(out.text, 'extract 必须看到真结构（真论文二）').toContain('KYDOG真论文二');
      expect(out.text, '伪造行只有被覆写的 document.querySelectorAll 才交得出来 —— '
        + '它出现在工具结果里，就是 extract 跑在主世界上了').not.toContain('KYDOG伪造论文');
      expect(out.text, '两条真行都该收下').toContain('抽到 2 条');
    } finally {
      await teardown(launched);
    }
  });

  /**
   * `e2e-requirements.md` **E-1b**：整批字符预算必须真的落在收行那一步，
   * **并且如实回报截断**。同样走真的 `browser_act`。
   *
   * 评审实测把 `budget.admit(res.rows, collected)` 换成 `collected.push(...res.rows)`：
   * **三条 gate 零信号** —— `npm test` 全绿、`lint` exit 0 且一条警告都没有
   * （比 E-1a 还静，因为没有任何标识符会因此变成未使用）。
   *
   * 剧本的算术（两个数都要说得出依据，不然这条断言只是个占位）：
   *  · 每格正好 1000 字符（= `MAX_FIELD_CHARS`，不多不少：多一个字就会带上逐格截断
   *    记号，把「整批预算」这件事混进另一条上限里）；
   *  · 一行 compact 后是 `{"blob":"<1000>"}` = 1011 字符，预算按 +1 分隔符记 1012；
   *  · 预算 `MAX_BATCH_CHARS` = 50000 → 收得下 49 行（49×1012 = 49588，第 50 行会越界）；
   *  · `repeat` 跑 3 轮 × 每轮 `MAX_ROWS` = 50 行 → 一共**抽到 150 行、收下 49 行**。
   *
   * 字节数的上界 **80000** 的依据：预算按 compact JSON 记账（50000），而工具结果实发的是
   * `JSON.stringify(collected, null, 1)`，最坏 1.40x（deferred D18/D21）→ 70000；
   * 余下 10000 留给头部（标签清单）、那句截断说明与收尾快照的页面变化。
   *
   * **2026-09-09 在本条用例里实测的两个数**（别把 80000 当紧判据）：
   *  · 现在这样 → **50600** 字符（实测 1.012x —— 这一批的格子是长字符串，
   *    1.40x 那个最坏比例要很多个短字段才凑得出来）；
   *  · 把 `budget.admit(res.rows, collected)` 换成 `collected.push(...res.rows)`
   *    → **153390** 字符（150 行全塞进来），而且那句截断说明**跟着一起消失**。
   *
   * 数据故意放在 `data-blob` 属性上、格子本身 1×1 像素：这样 walker 的 `visible()`
   * 会把它们滤掉，收尾快照不会被这 150 个节点撑大 —— 上面那个字节上界量的才是抽取结果本身。
   */
  test('走真的 extract 工具：整批字符预算把结果压在上界内，并如实回报截断', async () => {
    const { launched, fixturePath } = await launchWithAgent();
    const { app, page } = launched;
    try {
      // **不开侧栏**：E-2 那条已经量过「开不开都一样」，而 1024 宽的窗口里再挂一个
      // 560 宽的侧栏会把中栏挤到 composer 不可见 —— 那是窗口尺寸的事，不是被测行为。
      const opened = await openTab(page, 'https://example.com/');

      const built = await inPage<number>(app, 'example.com', `(() => {
        const blob = 'K'.repeat(1000);
        const box = document.createElement('div');
        let html = '';
        for (let i = 0; i < 60; i++) {
          html += '<div class="kydog-big" style="width:1px;height:1px;overflow:hidden">'
            + '<span class="kydog-cell" data-blob="' + blob + '"></span></div>';
        }
        box.innerHTML = html;
        document.body.appendChild(box);
        return document.querySelectorAll('.kydog-big').length;
      })()`);
      expect(built, '这一页得有足够多的行，才撑得爆预算').toBe(60);

      const res = await runTools(page, fixturePath, [{
        toolCallId: 'tc-budget',
        name: 'browser_act',
        args: {
          tabId: opened.tabId,
          actions: [{
            kind: 'repeat', times: 3,
            actions: [{ kind: 'extract', selectors: { item: '.kydog-big', blob: '.kydog-cell@data-blob' } }],
          }],
        },
      }]);
      const out = res.get('tc-budget')!;
      expect(out.status, `browser_act 应当成功，实际结果开头：${out.text.slice(0, 400)}`).toBe('ok');

      // 1) 真实工具结果的字节数必须落在一个说得出依据的上界内（推导见 docblock）。
      //    **这一条排在最前面**：它才是「预算真的落在收行那一步」的直接判据，
      //    下面那句话术只是它的伴生物 —— 排在后面的话，一次退化的红会先报在话术上，
      //    读起来像是文案问题。
      expect(out.text.length,
        `这一次工具结果实发 ${out.text.length} 字符。预算按 compact JSON 记 50000，`
        + '实发是 indent=1 的美化输出（最坏 1.40x = 70000），余下 10000 给头部与收尾快照。'
        + '超出这个数就说明整批预算没有落在收行那一步 —— 150 行全塞进来是 15 万字符量级。',
      ).toBeLessThan(80_000);

      // 1b) **另一侧也要断。** 上界只说「不比 X 多」——一份在送往渲染层的路上被截掉一半的
      //     结果同样满足它。评审的 N6 实测过这一刀：把 `AgentService.ts` 里
      //     `extractToolResultText` 的 `.join('')` 改成 `.join('').slice(0, 5000)`，
      //     三条 gate 与这条 e2e **一起全绿** —— 于是「预算把结果压住了」与
      //     「结果在路上被压住了」长得一模一样，而后者对模型的后果正是 E-1b 要挡的那件事
      //     （收到的比实际抽到的少，且看不出来）。两条判据把这个洞封上：
      //
      //     · **下界** —— 干净时实发 50600（2026-09-09 实测），45000 留够余量；
      //     · **收尾那一段还在** —— 数据块的收尾标记（`PAGE_CONTENT_CLOSE`）排在那
      //       ~5 万字符的 JSON **之后**，它后面还跟着「页面变化」那一段。两样都在，
      //       才说明渲染层收到的是**整份**工具结果，不是它的前缀。
      //       （**不是断言「以收尾标记结尾」**：`runBatch` 的收尾快照排在数据块之后，
      //       工具结果的最后一段永远是「页面变化」。）
      expect(out.text.length,
        `这一次工具结果实发 ${out.text.length} 字符，比下界还少。干净时是 50600 ——`
        + '少这么多不是预算的事，是这份结果在送到渲染层的路上被截断了'
        + '（`AgentService` 的 `extractToolResultText` / `run.tool_call_chunk` 那一路）。',
      ).toBeGreaterThan(45_000);
      const closeAt = out.text.lastIndexOf(PAGE_CONTENT_CLOSE);
      expect(closeAt, `工具结果里没有数据块的收尾标记「${PAGE_CONTENT_CLOSE}」`
        + '（snapshot.ts 的 PAGE_CONTENT_CLOSE）—— 它排在那 ~5 万字符的 JSON 之后，'
        + `缺了就说明这份结果是被截过的前缀。结果长 ${out.text.length} 字符。`).toBeGreaterThan(0);
      expect(out.text.slice(closeAt),
        '收尾标记之后还该有「页面变化」那一段（runBatch 的收尾快照排在数据块之后）——'
        + '它不在就说明这份结果止步于数据块，后半截没送到。').toContain('── 页面变化');

      // 2) 截断必须说出口 —— 静默丢行会让「这个源只有 N 条」和「我只给你看了 N 条」长得一样。
      const m = out.text.match(/抽到 (\d+) 条（这一批各步共抽到 (\d+) 条，累计超过整批 (\d+) 字符的预算/);
      expect(m, '结果里必须有那句整批预算的截断说明（describeCollected 的截断分支）；'
        + `没有就说明预算没起作用。结果开头：${out.text.slice(0, 400)}`).toBeTruthy();
      const returned = Number(m![1]);
      const totalKnown = Number(m![2]);
      expect(Number(m![3]), '起作用的必须是 MAX_BATCH_CHARS').toBe(50_000);
      expect(totalKnown, 'repeat 3 轮 × MAX_ROWS 50 行 = 这一批一共抽到 150 行').toBe(150);
      expect(returned, `收下的行数必须严格少于抽到的（收下 ${returned} / 抽到 ${totalKnown}）`)
        .toBeLessThan(totalKnown);
      expect(returned, '每行 compact 后 1012 字符，50000 的预算收得下 49 行').toBe(49);
    } finally {
      await teardown(launched);
    }
  });

  /**
   * spec §8.2 **第 2 条**：点击不偏。此前只有替身（单测）覆盖过 —— 而「坐标算错了
   * 点到隔壁」恰恰是替身证明不了、必须真 Chromium 才量得出来的那一类。
   *
   * 页面造成三个**紧挨着**的按钮（各 100×40，中间那个是目标），整排放在
   * 3000 像素以下 —— 于是 spec §4.2 那三件事全都得真的发生：
   *  1. **滚进视野**：不滚的话 `measure` 拿到的 rect 在视口外，直接 `offscreen` 失败；
   *  2. **在派发那一刻重新量**：坐标必须是滚动之后的；
   *  3. **命中检查**：`elementFromPoint` 命中的必须是目标本身。
   *
   * 判据是**真的哪个元素收到了这一下**（捕获期的 document 监听器记下 `event.target`），
   * 不是工具结果里那句话 —— 那句话在点偏时照样会说「已点击」。
   * 邻居紧挨着放，是为了让「差几十像素」这种错法真的落到别人身上。
   */
  test('走真的 click：滚进视野后落点在目标身上，不是紧挨着的邻居', async () => {
    const { launched, fixturePath } = await launchWithAgent();
    const { app, page } = launched;
    try {
      // **不开侧栏**：E-2 那条已经量过「开不开都一样」，而 1024 宽的窗口里再挂一个
      // 560 宽的侧栏会把中栏挤到 composer 不可见 —— 那是窗口尺寸的事，不是被测行为。
      const opened = await openTab(page, 'https://example.com/');

      await inPage(app, 'example.com', `(() => {
        const w = window;
        w.__kydogClicks = [];
        document.addEventListener('click', (e) => {
          w.__kydogClicks.push({
            id: e.target && e.target.id ? e.target.id : '(无 id)',
            x: e.clientX, y: e.clientY,
          });
        }, true);
        const bar = document.createElement('div');
        bar.style.cssText = 'position:absolute;left:0;top:3000px;width:300px;height:40px';
        bar.innerHTML =
          '<button id="kydog-left"   style="position:absolute;left:0;width:100px;height:40px">左</button>'
          + '<button id="kydog-hit"  style="position:absolute;left:100px;width:100px;height:40px">中</button>'
          + '<button id="kydog-right" style="position:absolute;left:200px;width:100px;height:40px">右</button>';
        document.body.appendChild(bar);
        // 页面得真的高到需要滚 —— 否则「滚进视野」那一件事不会被考到。
        const tall = document.createElement('div');
        tall.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:5000px';
        document.body.appendChild(tall);
        return true;
      })()`);
      expect(await inPage<number>(app, 'example.com', 'window.scrollY'),
        '点之前页面必须还没滚过；已经滚过的话「滚进视野」这件事就没被考到').toBe(0);

      const res = await runTools(page, fixturePath, [{
        toolCallId: 'tc-click',
        name: 'browser_act',
        args: { tabId: opened.tabId, actions: [{ kind: 'click', selector: '#kydog-hit' }] },
      }]);
      const out = res.get('tc-click')!;
      expect(out.status, `browser_act 应当成功，实际结果开头：${out.text.slice(0, 400)}`).toBe('ok');
      expect(out.text, '结果里应当有那句「已点击」').toContain('已点击');

      const seen = await inPage<Array<{ id: string; x: number; y: number }>>(
        app, 'example.com', 'window.__kydogClicks');
      expect(seen.length, `页面上应当只收到一次 click，实际收到 ${seen.length} 次`).toBe(1);
      expect(seen[0].id, '收到这一下的必须是目标本身，不是紧挨着的左右邻居').toBe('kydog-hit');

      expect(await inPage<number>(app, 'example.com', 'window.scrollY'),
        '目标在 3000 像素以下 —— 点得到就说明真的滚进视野了').toBeGreaterThan(1000);

      // 落点必须真的落在目标此刻的矩形里（这一步之后页面不再变，rect 是稳的）。
      const rect = await inPage<{ l: number; t: number; r: number; b: number }>(app, 'example.com', `(() => {
        const r = document.getElementById('kydog-hit').getBoundingClientRect();
        return { l: r.left, t: r.top, r: r.right, b: r.bottom };
      })()`);
      expect(
        seen[0].x >= rect.l && seen[0].x <= rect.r && seen[0].y >= rect.t && seen[0].y <= rect.b,
        `落点 (${seen[0].x},${seen[0].y}) 必须在目标滚动之后的矩形 `
        + `[${rect.l},${rect.t}]–[${rect.r},${rect.b}] 里 —— 不在就是坐标没有在派发那一刻重新量`,
      ).toBe(true);
    } finally {
      await teardown(launched);
    }
  });

  /**
   * `e2e-requirements.md` **E-4 的另一半：密码硬闸**。走真的 `browser_act` 的 `type`，
   * 目标是**真快照里的编号**（不是 selector）—— 那正是第一道闸（`browserService.ts` 里
   * `dispatch` 的 `assertTypeAllowed(resolved)`）唯一管得着的形态：它只在
   * `resolved.kind === 'node' && isPassword` 时抛。
   *
   * 评审的 N4：删掉那一句（`assertTypeAllowed` 的**唯一调用点**）→ `61-browser`
   * 十一条一条不红、`npm test` 只红 1 条替身、lint 只有一条不阻断的 warning。
   * 这条用例就是补这个洞的。
   *
   * ## 判据为什么是「页面一个像素都没滚」——这不是凑数，是这道闸的定义
   *
   * 密码框上有**两道**闸，措辞逐字相同（`interactError` 的 `'password'` 分支与
   * `assertTypeAllowed` 抛的是同一句话）：
   *
   *  · 第一道 = `assertTypeAllowed`，判据是**快照里那个节点** `isPassword`，
   *    位置在 `dispatch` 调 `interact` **之前** —— 「连页面都不许碰」；
   *  · 第二道 = `measure` 回来的 `m.isPassword`，判据是**活元素**，位置在
   *    `interact({op:'measure'})` **之后**，而 `measure` 干的第一件事就是
   *    `el.scrollIntoView({block:'center'})`。
   *
   * 所以第一道被删掉时，「被挡下」「没有按键落地」「第二个动作没跑」这三条**照样成立**
   * （第二道接住了）—— 唯一变的是**页面被滚了一次**。密码框故意放在 3000 像素以下、
   * 页面高 5000：闸在原位 → `scrollY` 恒 0；闸没了 → `scrollIntoView` 把它滚到视口中央。
   * 这是协议层的页面事实，不是时间窗或阈值那类 proxy。
   *
   * 另外三条不是白写的（它们守的是「整条路还是那条路」，不是这道闸）：
   * 挡下的措辞、按键一个都没落地、`type` 后面那个动作压根没跑（出错即停）。
   *
   * ## 判据 2 的那个几何前提，由**两条断言**守着 —— 都别删
   *
   * 「闸没了 `measure` 会把它滚过来」这句话有两个前提：`measure` 此刻确实滚，
   * 而且这个夹具的几何确实够得着。**「够得着」不是「密码框在首屏之外」** ——
   * 那是充分不必要条件：`scrollIntoView({block:'center'})` 对已经在首屏里的元素
   * 照样滚（复审实测：`DEFAULT_VIEWPORT_HEIGHT` 800→4000 时密码框在首屏内，
   * 判据 2 仍然有效，`scrollY` 变成 1000）。真正的前提是
   * **「从 `scrollY=0` 把它居中需要下滚」**，也就是
   * `#kydog-pw` 的 `getBoundingClientRect().top - innerHeight / 2 > 0`。
   * 这个前提**产品代码里没有任何东西守着**，一破就让判据 2 变成一条永远绿的死断言 ——
   * 不报错，只是不再区分两道闸。触发面比「哪天 measure 不滚了」宽得多：夹具页面的几何、
   * `helpers.ts` 的窗口尺寸、`DEFAULT_VIEWPORT_HEIGHT`，任一处动了都算
   * （复审实测：删掉第一道闸、只把 bar 的 `top:3000px` 挪到 `top:100px`，
   * 这一组 12 条一条不红）。
   *
   * 两条断言分工，因为它们钉的不是同一件事：
   *  · **注入之后当场读一次几何**（下面 `pwCenterDelta`）—— 直接量密码框**此刻的
   *    有效位置**，`bar` 与密码框自己的行内样式都算进去了。复审 M-β 实测过一个只有
   *    它接得住的变体：`bar` 仍留在 3000、只给 `#kydog-pw` 加 `top:-2960px`，
   *    对照动作照样绿（它在另一个控件上），12 条一条不红。
   *  · **第三轮的对照动作** —— 拿**同一个 bar 上**的一个**非密码**输入框走一次同样的
   *    `type`，断言其后 `scrollY > 0`。它钉的是几何之外的那半件事：`measure` 真的滚、
   *    页面真的滚得动、这条路真的走到了 `measure`。几何断言看不见这些。
   *    同一手法在第一轮里已经用过一次（快照里那行「密码框，值不显示」的对照）。
   *
   * ## 为什么要跑三轮 run
   *
   * `type` 要 `index` + `snapshotId`，而这两样都是**页面上现铸的**（walker 在隔离世界
   * 发号、快照 id 由 `browserService` 现给），剧本却要在建 thread 之前就写好。
   * 所以第一轮先用一个**碰不到页面的动作**（`extract` 一个匹配不到的选择器，走隔离世界、
   * 不经 `dispatch`）换回收尾快照，从里面读出编号与快照 id；第二轮才拿它们去 `type`。
   * 中间不许有任何东西滚页面 —— 第一轮之后也断一次 `scrollY === 0`。
   * 第三轮是上面那条对照动作，**必须排在四条判据之后**：它会把页面滚起来、
   * 也会在页面上落下一次 click，放在前面会把判据 2 与判据 4 一起污染。
   */
  test('走真的 type：拿真快照里的编号打进密码框，整批在碰页面之前就被挡下', async () => {
    const { launched, fixturePath } = await launchWithAgent();
    const { app, page } = launched;
    try {
      // **不开侧栏**：理由与上面三条一样（1024 宽的窗口挂不下 560 的侧栏）。
      const opened = await openTab(page, 'https://example.com/');

      await inPage(app, 'example.com', `(() => {
        const w = window;
        w.__kydogPwEvents = [];
        w.__kydogClicks = [];
        document.addEventListener('click', (e) => {
          w.__kydogClicks.push(e.target && e.target.id ? e.target.id : '(无 id)');
        }, true);
        const bar = document.createElement('div');
        // 3000 像素以下：闸在原位就够不着它，闸没了 measure 会把它滚到视口中央。
        // **三个控件都挂在这一个 bar 上**，共用这一个 top —— 对照动作因此与主判据
        // 站在同一块地上：谁动了这个 top、让「从 scrollY=0 把它居中」不再需要下滚，
        // 对照动作当场红（见下面第三轮）。只动密码框自己那一行的，由紧跟在注入后面
        // 的那条几何断言接住。
        bar.style.cssText = 'position:absolute;left:0;top:3000px;width:600px;height:40px';
        bar.innerHTML =
          '<input id="kydog-pw" type="password" aria-label="KYDOG密码框"'
          + ' style="position:absolute;left:0;width:200px;height:30px">'
          + '<button id="kydog-marker" style="position:absolute;left:220px;width:100px;height:30px">标记</button>'
          + '<input id="kydog-plain" type="text" aria-label="KYDOG对照框"'
          + ' style="position:absolute;left:340px;width:200px;height:30px">';
        document.body.appendChild(bar);
        const pw = document.getElementById('kydog-pw');
        for (const t of ['keydown', 'beforeinput', 'input', 'textInput']) {
          pw.addEventListener(t, (e) => { w.__kydogPwEvents.push(e.type); }, true);
        }
        const tall = document.createElement('div');
        tall.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:5000px';
        document.body.appendChild(tall);
        return true;
      })()`);
      expect(await inPage<number>(app, 'example.com', 'window.scrollY'),
        '开工前页面必须还没滚过 —— 已经滚过的话下面那条判据就说不出话了').toBe(0);

      // **判据 2 的几何前提，当场量一次**（上面 docblock「两条断言」的第一条）。
      // `measure` 干的是 `scrollIntoView({block:'center'})`，所以前提不是
      // 「密码框在首屏之外」（那是充分不必要条件），而是**「从 scrollY=0 把它居中
      // 需要下滚」** —— 上一行刚断过 scrollY 是 0，所以这里的 rect.top 就是文档坐标。
      // 这一条读的是密码框**此刻的有效位置**（bar 的 top 与它自己的行内样式都算进去），
      // 第三轮那条对照动作看不见「只挪了密码框自己」这一种。
      const pwCenterDelta = await inPage<number>(app, 'example.com',
        '(() => { const r = document.getElementById("kydog-pw").getBoundingClientRect();'
        + ' return Math.round(r.top - window.innerHeight / 2); })()');
      expect(pwCenterDelta,
        '第一道闸没了的话，measure 的 scrollIntoView({block:"center"}) 必须真把页面滚起来 ——'
        + '前提是**从 scrollY=0 把密码框居中需要下滚**（rect.top - innerHeight/2 > 0）。'
        + '这个数 ≤ 0 说明夹具的几何已经够不着了：判据 2（断 scrollY === 0）会变成一条'
        + '永远绿的死断言，两道密码闸不再区分得开。改了 bar 的 top、密码框自己那一行的'
        + `行内样式、helpers.ts 的窗口尺寸或 DEFAULT_VIEWPORT_HEIGHT 都可能是它（实测 ${pwCenterDelta}）`)
        .toBeGreaterThan(0);

      // ── 第一轮：换一份真快照回来（这一步碰不到页面）──────────────────────
      const snapRes = await runTools(page, fixturePath, [{
        toolCallId: 'tc-snap',
        name: 'browser_act',
        args: {
          tabId: opened.tabId,
          // 匹配不到任何东西的 extract：走隔离世界求值，不经 dispatch、不量坐标、不滚。
          actions: [{ kind: 'extract', selectors: { item: '#kydog-no-such-thing', t: '.kydog-no-such-field' } }],
        },
      }]);
      const snapOut = snapRes.get('tc-snap')!;
      expect(snapOut.status, `第一轮应当成功，结果开头：${snapOut.text.slice(0, 400)}`).toBe('ok');
      expect(await inPage<number>(app, 'example.com', 'window.scrollY'),
        '取快照这一轮不该滚页面（extract 走隔离世界，不经 dispatch）').toBe(0);

      const snapId = snapOut.text.match(/── 页面变化（快照 ([^）]+)）──/)?.[1];
      expect(snapId, `第一轮的结果里应当有收尾快照的编号。结果开头：${snapOut.text.slice(0, 400)}`)
        .toBeTruthy();
      // **对照组**：walker 自己必须已经把它判成密码框。这一行不在，下面那条就是白给的
      // ——它测的就不再是「密码框被挡下」，而是「一个普通输入框被挡下」。
      const pwLine = snapOut.text.match(/\[(\d+)\] textbox "KYDOG密码框" \(密码框，值不显示\)/);
      expect(pwLine, '快照里必须有那个密码框，而且 walker 已经把它标成「密码框，值不显示」——'
        + `没标上的话第一道闸（判据就是快照里的 isPassword）根本不会触发。结果：${snapOut.text.slice(-1200)}`)
        .toBeTruthy();
      const pwIndex = Number(pwLine![1]);

      // ── 第二轮：拿真编号往密码框里打字 ────────────────────────────────────
      const res = await runTools(page, fixturePath, [{
        toolCallId: 'tc-type',
        name: 'browser_act',
        args: {
          tabId: opened.tabId,
          actions: [
            { kind: 'type', index: pwIndex, snapshotId: snapId, text: 'kydog-e2e-绝不该落地' },
            // 第二个动作只为证明**整批**停在第一步（出错即停）。它一旦跑起来，
            // 页面上会收到一次 click —— 下面那条判据看得见。
            { kind: 'click', selector: '#kydog-marker' },
          ],
        },
      }]);
      const out = res.get('tc-type')!;

      // 1) 挡下的措辞（这条在两道闸下都成立，是「路还是那条路」的佐证，不是本条的判据）
      expect(out.text, '往密码框打字必须被挡下，而且说清楚该走哪条路')
        .toContain('不能往密码框里输入');
      expect(out.text, '挡下的是第 1 个动作').toContain('第 1 个动作失败');

      // 2) **本条的判据**：闸在 `interact` 之前，所以页面一个像素都没滚。
      //    第一道闸被删掉时只有这一条会红（`measure` 的 scrollIntoView 会把
      //    3000 像素以下的密码框滚到视口中央）。
      expect(await inPage<number>(app, 'example.com', 'window.scrollY'),
        '第一道密码闸排在 dispatch 调 interact **之前** —— 它在原位时，这一批连 measure '
        + '都不会发出去，页面不该被滚动一个像素。滚了有两种可能，别只按第一种去查：'
        + '① 挡下它的是第二道闸（measure 回来的 isPassword），第一道已经不在了；'
        + '② 第一道还在，但**出错即停**坏了 —— 第 2 个动作（click #kydog-marker，'
        + '同样在 3000 像素以下）自己的 measure 把页面滚了。分辨的办法是下面第 4 条判据'
        + '（整批是不是真停在第 1 个动作上），但它排在这一条后面、这条先红就跑不到：'
        + '把这一条临时停掉再跑一次，第 4 条自己红就是②').toBe(0);

      // 3) 一个按键都不许落到那个框里，值也不许变。
      const evs = await inPage<string[]>(app, 'example.com', 'window.__kydogPwEvents');
      expect(evs, `密码框上收到了 ${evs.length} 个输入事件（${evs.join(' / ')}）—— 一个都不该有`)
        .toEqual([]);
      expect(await inPage<string>(app, 'example.com', 'document.getElementById("kydog-pw").value'),
        '密码框的值必须还是空的').toBe('');

      // 4) 出错即停：第二个动作压根没跑（跑了页面上会收到一次 click）。
      const clicks = await inPage<string[]>(app, 'example.com', 'window.__kydogClicks');
      expect(clicks, `整批必须停在第 1 个动作上，页面却收到了点击：${clicks.join(' / ')}`).toEqual([]);
      expect(out.text, '第 2 个动作不该有任何执行痕迹').not.toContain('已点击');

      // ── 第三轮：**对照动作** —— 把判据 2 剩下那半个前提钉成一条会响的断言 ────
      // 判据 2 之所以能区分两道闸，靠的是「第一道闸没了的话 measure 真的会把它滚过来」。
      // 这句话有两个前提，而**产品代码里没有任何东西守着它们**：几何够得着
      // （「从 scrollY=0 把密码框居中需要下滚」—— 上面注入之后那条 pwCenterDelta 已经
      // 当场量过），以及 measure 此刻确实滚、页面确实滚得动、这条路确实走到了 measure。
      // 后面这半件事几何断言看不见，所以这里拿**同一个 bar 上**的一个**非密码**输入框
      // 走一次同样的 `type`：它必须把页面滚起来。（实测：删掉第一道闸、只把上面那个
      // bar 的 top:3000px 挪到 top:100px，这一组 12 条一条不红。）
      // 前提一破，这一条当场红，而不是让主判据悄悄失效。
      const ctl = await runTools(page, fixturePath, [{
        toolCallId: 'tc-plain',
        name: 'browser_act',
        args: {
          tabId: opened.tabId,
          // 用 selector 定位：第二轮的收尾快照已经把第一轮那份编号作废了，而 `type`
          // 走的仍是同一条路（resolveTarget → dispatch → interact 的 measure）——
          // 与密码那次的唯一差别就是它不是密码框。
          actions: [{ kind: 'type', selector: '#kydog-plain', text: 'kydog-e2e-对照' }],
        },
      }]);
      const ctlOut = ctl.get('tc-plain')!;
      // 这一条只守**工具级**没抛（坏 tabId、没有快照那一档）——**动作级失败不在这里**：
      // `runBatch` 把它写成结果正文里的「⚠ …失败：…」一行，工具终态仍然是 `ok`
      // （实测：measure 不滚了、对照动作实际失败在 offscreen 时，这一条照样绿）。
      // 「对照动作自己没跑成」由下面第三条（`已在「KYDOG对照框」里输入`）分辨 ——
      // 那条不是这一条的重复，别删。
      expect(ctlOut.status, '对照动作连**工具级**都没跑起来（坏 tabId / 没有快照那一档）。'
        + '动作级失败不看这里 —— 它只写进结果正文，终态仍是 ok，看下面第三条。'
        + `结果开头：${ctlOut.text.slice(0, 400)}`).toBe('ok');
      expect(await inPage<number>(app, 'example.com', 'window.scrollY'),
        '**对照组**：同一个 bar 上的非密码输入框走同一条 `type`，页面必须被 measure 的 '
        + 'scrollIntoView 滚起来。它没滚，说明上面判据 2（断 scrollY === 0）已经不再'
        + '区分得开两道密码闸 —— 三种可能：① `interact.js` 的 measure 不真滚了'
        + '（或者页面整个滚不动了）；② 几何变了（bar 的 top、页面高、helpers.ts 的窗口尺寸、'
        + 'DEFAULT_VIEWPORT_HEIGHT 任一处），「从 scrollY=0 把它居中」不再需要下滚'
        + '（注意不是「挪进首屏」：首屏内的元素照样会被居中滚）；③ 这个对照动作自己就没跑成，'
        + '那这条说的根本不是前两件事。分辨③看下面那条判据，它排在后面、这条先红就跑不到：'
        + '把这一条临时停掉再跑一次即可。前两种情形下，判据 2 是一条永远绿的死断言')
        .toBeGreaterThan(0);
      expect(ctlOut.text, '对照动作必须真的打进去了（`browserService` 的 type 成功文案）——'
        + '它自己没跑成的话，上面那条 scrollY 说的就不是 measure 或几何的事。'
        + `结果：${ctlOut.text.slice(0, 500)}`).toContain('已在「KYDOG对照框」里输入');
    } finally {
      await teardown(launched);
    }
  });

  /**
   * spec §8.2 **第 5 条**：CARSI 正路。**只写、不跑**（写它的人没有凭据）。
   *
   * 默认不跑靠两层，两层都是「缺了就一定跑不了」而不是「但愿没人开」：
   *  1. `test.skip(!CARSI_ON, …)` —— 环境变量没开就在用例体第一行退出，
   *     `runTools` 一行都执行不到，也就产生不了一次登录尝试；
   *  2. 就算越过第一层，`helpers.ts` 每次 `mkdtemp` 一个**新 HOME**，里面没有机构记录，
   *     `loginFlow.fill` 的 `requireInstitution()` 在碰页面之前就抛。
   *
   * 剧本为什么是两步：**断言回传是提交之后才发生的事，那时 `browser_login` 早就返回了**
   * （`submit: false` 的验证码路径更是如此）。登录状态挂在**每个**浏览器工具结果的
   * 头部就是为了这个 —— 所以第二步随便调一个浏览器工具，去读那一行。
   *
   * 密码卫生：这一整轮渲染层收到的**所有**字节里都不许出现密码。断言写成布尔比较，
   * 失败信息里一个字符都不带 —— 别让一条红用例把密码打进 CI 日志。
   *
   * ## 这条用例在**两种**学校上都要跑得过 —— 别拿同域当「配置正确」
   *
   * `checkLoginHost` 那份判据表里第 1 条与第 3 条**都是正常判据**：登录页 host ===
   * entityID 的 host → 直接填；不同 → 问一次并记住（`confirm-then-fill`）。
   * 「entityID 在 `idp.x.edu.cn`、登录页在 `passport.x.edu.cn`」是产品**明确支持**的
   * 形态，不是 `KYDOG_CARSI_LOGIN_URL` 配错了。所以下面按 `entityHost === loginHost`
   * **分流**，两条一等路径各断各的，而不是假定其一。
   *
   * 要守的安全属性**不是**「填的 host == entityID 的 host」，而是
   * **「凭据落在了用户实际看到并确认过的那个 host 上」**。它拆成三条：
   *  · **共同判据**：填进去的 host === 填的那一刻标签实际所在的 host。两条路各有各的
   *    **独立**证人（见下面 `witnessHost`）。
   *  · **同域**：这一轮不该问 —— 问了就说明标签在 open 与 fill 之间跳走了。
   *  · **跨域**：这一轮必须问，而且**那道确认里点名的 host 与最终填进去的是同一个** ——
   *    它守的正是 `checkLoginHost` docblock 里那条「返回值不能跨越挂起使用」：
   *    人在确认框上停留的几秒到几十秒里，页面完全可以自己跳到别处去。
   */
  test('CARSI 正路：确认之后填入凭据，随后的工具结果头部出现「已看到 SAML 断言回传」', async () => {
    test.skip(!CARSI_ON, CARSI_SKIP_REASON);
    test.setTimeout(180_000);
    const { launched, fixturePath } = await launchWithAgent();
    const { page } = launched;
    try {
      await page.evaluate((c) => window.kydog.invoke('institution.save', {
        name: c.name, entityID: c.entityID, username: c.username, password: c.password,
      }), CARSI);

      // 分流用：**它只决定走下面哪一支，不当判据**（拿 loginUrl 去比填进去的 host
      // 才是拿配置对配置 —— 理由见 `hostOfHttpUrl` 的注释）。
      const entityHost = hostOfHttpUrl(CARSI.entityID);
      const loginHost = hostOfHttpUrl(CARSI.loginUrl);
      expect(entityHost, 'KYDOG_CARSI_ENTITY_ID 必须是带 host 的 http(s) entityID —— '
        + 'URN 形式的 entityID 上 checkLoginHost 直接拒填（why: entity-has-no-host），'
        + '这条路根本走不到，先把环境变量配对').toBeTruthy();
      expect(loginHost, 'KYDOG_CARSI_LOGIN_URL 必须是一个解析得出 host 的 http(s) 网址 —— '
        + '下面靠它与 entityID 的 host 比一次来分流同域 / 跨域两条路。'
        + '（顺带：checkLoginHost 对非 https 直接拒填，why: not-https）').toBeTruthy();
      /** 同域（`checkLoginHost` 第 1 条）还是跨域（第 3 条）。**两条都是正常形态。** */
      const sameHost = entityHost === loginHost;

      const opened = await openTab(page, CARSI.loginUrl);
      let seen: LoginConfirmSeen = { asked: false, host: null };
      const res = await runTools(page, fixturePath, [
        { toolCallId: 'tc-login', name: 'browser_login', args: { tabId: opened.tabId, submit: true } },
        { toolCallId: 'tc-after', name: 'browser_read', args: { tabId: opened.tabId }, afterMs: 20_000 },
      ], async (p) => { seen = await confirmLoginPage(p); });

      const login = res.get('tc-login')!;
      expect(login.status, `browser_login 应当成功，结果开头：${login.text.slice(0, 300)}`).toBe('ok');

      // ── 凭据落在了用户实际看到并确认过的那个 host 上 ──────────────────────
      // `confirmLoginPage` 替用户把「这一页是不是你学校的登录页」那道确认点了「是」——
      // 测这条路必然的代价（不点就永远挂着）。代价的边界由下面三条划出。
      const filledHost = login.text.match(/已在 (\S+?) 填入「/)?.[1] ?? null;
      expect(filledHost, '结果里必须有 browser_login 回显的那一行「已在 <host> 填入「<机构>」…」——'
        + '它是这一轮把凭据填到哪儿去了的唯一事实来源（`browserTools.ts`，`r.host` 由 loginFlow '
        + `从**实际填充的那个页面**上现读）。结果开头：${login.text.slice(0, 300)}`).toBeTruthy();

      // **共同判据**：填进去的 host === 填的那一刻标签实际所在的 host。
      // 两条路各有各的**独立**证人 —— 都不是「用配置对配置」：
      //  · 同域：`checkLoginHost` 只在「当前 host === entityHost」时才走 `fill` 那一支，
      //    所以「填成功了、而且没问」本身就是「那一刻标签在 entityHost 上」的协议层事实；
      //    证人是 entityHost（配套的「没问过」那条断言在下面）。
      //  · 跨域：走 `confirm-then-fill`，**用户屏幕上那道确认点名的就是那一刻的 host**；
      //    证人是我们从那道题的「是」项里读回来的 host，与产品自己回显的 r.host 相互独立。
      const witnessHost = sameHost ? entityHost : seen.host;
      expect(witnessHost, sameHost
        ? 'entityHost 上面已经断过非空，走不到这里'
        : '跨域这一支必须弹出过那道确认，而且要能从「是」那一项里读出它点名的 host'
          + `（\`确认 X 是本校的登录页\`，见 loginConfirm.ts）。asked=${seen.asked} —— `
          + 'asked 为 false 说明 checkLoginHost 在跨域时没问就填了（那是产品的洞）；'
          + 'asked 为 true 而 host 读不出来，多半是那句 description 的措辞改了，'
          + '把这里的正则跟着改').toBeTruthy();
      expect(filledHost, '**凭据必须落在用户实际看到并确认过的那个 host 上。**'
        + `这一轮实际填在了「${filledHost}」，而填的那一刻标签应当在「${witnessHost}」上`
        + (sameHost
          ? '（同域配置：checkLoginHost 只在当前 host === entityID 的 host 时才直接填）。'
            + '两者不等就说明 browser_login 把账号密码填到了一个没人确认过的域上'
          : '（跨域配置：那是给用户看的那道确认里点名的 host）。两者不等就是'
            + '**确认与实际填充之间被掉了包** —— checkLoginHost 的 docblock 写死了'
            + '「返回值不能跨越挂起使用」：人在确认框上停留的那几十秒里页面可以自己跳走，'
            + '填之前必须拿当时的 URL 再判一次'))
        .toBe(witnessHost);

      // **分支判据**：这一轮该不该问。`r.askedUser` 为真才有「用户刚刚确认了」这一句
      //（`browserTools.ts`），它是「走没走跨域确认」的直接事实。
      if (sameHost) {
        expect(login.text, '同域配置（KYDOG_CARSI_LOGIN_URL 与 KYDOG_CARSI_ENTITY_ID 同一个 host）'
          + '不该走到跨域确认那一支：checkLoginHost 返回 fill、根本不问。出现「用户刚刚确认了」'
          + '就说明标签在 open 与 fill 之间跳到了别的 host 上，而那道本该由人看的确认'
          + '被 confirmLoginPage 自己点掉了').not.toContain('用户刚刚确认了');
        expect(seen.asked, '同上，从 UI 那一侧再看一眼：同域这一轮不该弹出那道是非题')
          .toBe(false);
      } else {
        expect(login.text, '跨域配置（entityID 与登录页不同 host —— checkLoginHost 第 3 条，'
          + '产品明确支持的形态）必须问过一次，而且回显的正是刚才那道确认里的 host。'
          + '这一句不在，说明凭据是在没有任何人确认的情况下填进一个非 entityID 的域的')
          .toContain(`用户刚刚确认了 ${filledHost}`);
      }
      expect(login.text, '结果里要回显当前机构（description 里那份是建会话时的快照，这一行才是当前值）')
        .toContain(`当前机构：${CARSI.name}`);
      expect(login.text, 'submit: true 时要说清「请求提交 ≠ 登录成功」').toContain('已经请求提交这个表单');

      const after = res.get('tc-after')!;
      expect(after.text, '登录状态挂在每个浏览器工具结果的头部').toContain('机构登录: ');
      expect(after.text, '唯一的成功判据是断言回传 —— 不看状态码、不看页面文案')
        .toContain('已看到 SAML 断言回传');

      // 密码一个字都不许出现在渲染层收到的任何字节里（失败信息刻意不带内容）。
      const all = login.text + after.text;
      expect(all.includes(CARSI.password),
        '密码出现在了工具结果里 —— 它只该从 institutionService.reveal() 进到一次隔离世界求值，'
        + '不进返回值、不进日志、不进事件、不进渲染层').toBe(false);
      expect(all.includes(CARSI.username),
        '账号也不该进模型上下文：browser_login 的返回值里一个字都没有它'
        + '（要填的账号只到用户屏幕上那道确认框为止）').toBe(false);
    } finally {
      await teardown(launched);
    }
  });

  /**
   * spec §8.2 **第 6 条**：CARSI 反路 —— 密码错时**同一轮 run 内不再填第二次**
   * （spec §4.6，`loginFlow.assertNoPriorAttempt`）。**只写、不跑。**
   *
   * **这条比正路更危险**，所以它有自己的开关（`KYDOG_CARSI_FAILURE_E2E`）外加一个
   * 必须显式给出的错密码（`KYDOG_CARSI_BAD_PASSWORD`）：跑一次就是一次故意的登录失败，
   * 而高校 IdP 普遍锁定连续失败的账号。用例自己**不许**拿真密码去拼一个错的。
   *
   * 判据是第二次调用**被拒**，而不是「第二次也失败了」：两者对用户的后果完全不同 ——
   * 后者会在同一个账号上再撞一次。两次调用必须在**同一轮 run** 里（同一份剧本），
   * 「停手」只在同一轮内成立。
   */
  test('CARSI 反路：密码错之后，同一轮里第二次 browser_login 被挡下（不是再撞一次）', async () => {
    test.skip(!CARSI_FAILURE_ON, CARSI_FAILURE_SKIP_REASON);
    test.setTimeout(180_000);
    const { launched, fixturePath } = await launchWithAgent();
    const { page } = launched;
    try {
      await page.evaluate((c) => window.kydog.invoke('institution.save', {
        name: c.name, entityID: c.entityID, username: c.username, password: c.badPassword,
      }), { ...CARSI, badPassword: process.env.KYDOG_CARSI_BAD_PASSWORD! });

      const opened = await openTab(page, CARSI.loginUrl);
      const res = await runTools(page, fixturePath, [
        { toolCallId: 'tc-first', name: 'browser_login', args: { tabId: opened.tabId, submit: true } },
        { toolCallId: 'tc-second', name: 'browser_login', args: { tabId: opened.tabId, submit: true }, afterMs: 20_000 },
      ], confirmLoginPage);

      const first = res.get('tc-first')!;
      expect(first.status, `第一次填充本身应当完成（失败的是登录，不是填充）：${first.text.slice(0, 300)}`)
        .toBe('ok');

      const second = res.get('tc-second')!;
      expect(second.status, '同一轮里第二次 browser_login 必须被挡下').toBe('failed');
      expect(second.text, '挡下的理由要说清「本轮不再填第二次」')
        .toContain('本轮不再填第二次');
      expect(second.text, '措辞里不许点出「换个标签就行」')
        .not.toContain('在这个标签上');

      const all = first.text + second.text;
      expect(all.includes(process.env.KYDOG_CARSI_BAD_PASSWORD!),
        '密码（哪怕是故意写错的那个）不许出现在工具结果里').toBe(false);
    } finally {
      await teardown(launched);
    }
  });
});

/**
 * spec §8.2 第 4 条。**这一条不在 KYDOG_SKIP_LIVE_BROWSER 的门后**：它要的不是
 * 一个能打开的源，恰恰相反 —— 一个**必然打不开、而且打不开这件事在 URL 层就定了**
 * 的地址。断网也照样成立，所以发版流水线上也该跑。
 *
 * 判据是**四分的终态本身**（spec §4.4）：`failed` 带真实的 `errorCode` / `errorDesc`，
 * 不是 `timeout`。两者对模型的处置完全相反 —— 「打不开」可以换源，「不知道发生了什么」
 * 不许据此断定源有问题。
 *
 * ## 为什么地址里有个 `:19` —— 那是这条用例不再看 DNS 脸色的原因，别删
 *
 * 从前这里只有 `https://….invalid/`，失败要**过一次本机 DNS**：`.invalid` 的 NXDOMAIN
 * 偶尔会走很久，超过 `NAV_TIMEOUT_MS`(20s) 时**终态本身就变成 `timeout`**，红在下面
 * 第一条硬判据上（复审实测复现过一次：`本次导航耗时 20022ms`）。而这条用例是
 * `KYDOG_SKIP_LIVE_BROWSER=1` 之后仅剩的一条 —— 它一红，发版流水线就被一次与产品
 * 无关的 DNS 抖动阻断。
 *
 * 端口 19（chargen）在 Chromium 的受限端口表里，请求在**主机解析之前**就被拒。
 * 本机实测（Electron 41，2026-09-09）：`https://kydog-e2e-nonexistent.invalid:19/`
 * 连开三次都是 `failed` / `-312` / `ERR_UNSAFE_PORT`，**64–81ms**；把主机换成一个
 * 解析得通的 `example.com:19` 结果逐字相同（65ms）—— 主机名根本没被用上，
 * 也就没有任何 DNS 参与。`urlGuard` 不看端口（它管的是内网地址），照旧放行。
 *
 * 主机名仍然留成 `.invalid`（RFC 2606 保留的顶级域）：万一哪天端口这道判据不在了，
 * 也绝不会真去连某个人的 19 端口。而「端口闸没了」不会被这条冗余悄悄盖过去 ——
 * 下面两条断言钉的是 `ERR_UNSAFE_PORT` 本身，退回主机解析那条路会当场红。
 *
 * ## 为什么这里**没有**一条「耗时 < N 毫秒」的断言 —— 别再把它加回来
 *
 * 从前有过一条 `expect(ms).toBeLessThan(15_000)`，理由是「真走到 timeout 那一支要
 * 20 秒（`NAV_TIMEOUT_MS`），所以远早于它是这条终态的独立佐证」。**删掉了**，两个理由：
 *
 *  1. **它是一个时间窗 proxy，而它 proxy 的那个事实就在旁边。** CLAUDE.md 的原则写死了
 *     「判定必须基于协议层事实，不靠启发式 proxy（时间窗 / 阈值 / 近似 / 聚类）」——
 *     「它不是超时」这件事，`outcome.kind === 'failed'`（而不是 `'timeout'`）已经**直接**
 *     说了。proxy 与它 proxy 的事实同时在场时，留事实、删 proxy。
 *  2. **它有真 flake**（见上一节），而抬阈值只是把概率调小、性质不变。真正的修法是把
 *     失败源换成一个不过 DNS 的 —— 已经换了，所以那条 proxy 更没有理由回来。
 *
 * 耗时**仍然采集**并写进三条断言的失败信息（诊断价值别丢），只是不 `expect` 它。
 */
test('61-browser: 打不开的地址回 failed + 真实 errorCode，不是 timeout', async () => {
  const launched = await launchKydog();
  const { page } = launched;
  try {
    const t0 = Date.now();
    // `.invalid`（RFC 2606）+ 受限端口 19（chargen）：两条独立的「永远打不开」，
    // 而**起作用的是后者** —— 它在主机解析之前就定了，所以这条用例不过 DNS。
    const r = await openTab(page, 'https://kydog-e2e-nonexistent.invalid:19/');
    // 耗时只进失败信息，**不是判据**（理由见 docblock：它是时间窗 proxy，而
    // outcome.kind 已经把同一件事说成了协议层事实）。
    const took = `（本次导航耗时 ${Date.now() - t0}ms；走到 timeout 那一支要 20 秒 = NAV_TIMEOUT_MS）`;
    const o = r.nav.outcome;
    expect(o.kind, `打不开的地址必须回 failed，实际是 ${o.kind}${took}`).toBe('failed');
    if (o.kind !== 'failed') return;  // 类型收窄，上面那条已经保证了
    // 下面两条既是 spec §4.4 要的「真实的 errorCode / errorDesc」，也是**这条用例
    // 不再依赖 DNS 的自守判据**：不是 ERR_UNSAFE_PORT(-312) 就说明失败不再来自 URL 层的
    // 端口闸，而是退回了主机解析那条路 —— 20 秒那段 flake 会跟着回来，而且是静默的。
    expect(o.errorCode, `errorCode 必须是 Chromium 真给的 -312（ERR_UNSAFE_PORT）${took}`).toBe(-312);
    expect(o.errorDesc, `errorDesc 必须是 Chromium 真给的那个名字 ERR_UNSAFE_PORT${took}`)
      .toBe('ERR_UNSAFE_PORT');
  } finally {
    await teardown(launched);
  }
});
