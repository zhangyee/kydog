import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage, type LaunchedApp } from './helpers';
import { MIN_MAIN_WIDTH } from '../src/renderer/app/rightPane';

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
 * 打不了公网的机器（断网、出口被墙）可以用 `KYDOG_SKIP_LIVE_BROWSER=1` 跳过整组，
 * **跳过原因带在用例上**（照 `src/test-support/symlinkCapability.ts` 的现成做法，
 * 不是静默绿）。**发版流水线不设它** —— 那里只跳性能那一条
 * （`KYDOG_SKIP_PERF_BROWSER`，见下面两个常量上的说明）。本机默认全跑。
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

/**
 * **整组跳过：只在「打不了公网」时用。**
 *
 * 这一组要打真源（`urlGuard` 只放行公网 http/https，起不了本地夹具服务器），
 * 所以断网 / 出口被墙的机器上会红一批。这个开关是给那种机器的逃生口。
 *
 * **它不是发版流水线的开关。** 从前 `release.yml` 上一直设着它，理由写的是
 * 「runner 是机房 IP，Google Scholar 对机房 IP 几乎必弹 robot check」——
 * 那句话对被它跳掉的用例**一条都不成立**：这一组里没有任何一条访问 Google Scholar
 * 或百度学术，9 条非 CARSI 的用例打的全是 `example.com/.org/.net`（IANA 保留域，
 * 由 ICANN 托管，不对 CI runner 做机器人判定；受控的页面内容靠打开后往里注入拿到），
 * 两条 CARSI 用例另有 `CARSI_ON` / `CARSI_FAILURE_ON` 的 opt-in 闸，这道闸对它们是多余的。
 * 代价是 `e2e-requirements.md` 的五条防线（E-1a/E-1b/E-2/E-3/E-4）在流水线上**一条都没跑**，
 * 而那五条正是各批评审逐条论证过「三条 gate 拦不住、只有 e2e 守得住」的那五条。
 * 现在流水线只留下面那道 `KYDOG_SKIP_PERF_BROWSER`。
 */
const SKIP_LIVE = process.env.KYDOG_SKIP_LIVE_BROWSER === '1';
const SKIP_REASON =
  'KYDOG_SKIP_LIVE_BROWSER=1：这一组要打真源。内置浏览器的 urlGuard 只放行公网 http/https，'
  + '起不了本地夹具服务器，所以打不了公网的机器（断网、出口被墙）跑不了这一组。'
  + '**发版流水线不设这个开关** —— 那里只跳性能那一条（KYDOG_SKIP_PERF_BROWSER）。'
  + '不跑就等于这一批一行都没验过。';

/**
 * **只跳性能断言那一条**（E-3，十二万节点 < 1500ms）。
 *
 * 它与这一组里其它用例不同：判据是**时间**，而慢 runner（共享 CPU、被别的 job 挤兑）
 * 上真有 flake 风险，红了也说明不了「内置浏览器坏了」。所以它单独留在闸后，
 * 而不是把整组一起跳掉。上界 1500ms 的依据与三个实测数写在那条用例的 docblock 里。
 */
const SKIP_PERF = process.env.KYDOG_SKIP_PERF_BROWSER === '1';
const PERF_SKIP_REASON =
  'KYDOG_SKIP_PERF_BROWSER=1：这一条断的是采集耗时（12 万节点 < 1500ms）。'
  + '慢 runner 上是真 flake，而且红了也说明不了「内置浏览器坏了」—— 发版流水线上只跳这一条。';

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

/**
 * 派发脚本的**生产源码本身**。`browserService` 用 `?raw` 注入的就是这一份字节。
 *
 * 调用约定照抄 `browserService.ts` 的 `interactExpression`（e2e 不能 import 主进程模块，
 * 见文件头）：整份源码是**一个箭头函数表达式**，拼成 `(<源码>)(<请求 JSON>)`。
 * 不带 `notAfter` = 不设时限 —— `interact.js` 那条自检只在它是数字时生效。
 */
const INTERACT_SOURCE = readFileSync(
  path.resolve(__dirname, '../src/main/browser/injected/interact.js'), 'utf8',
);
const interactExpr = (req: Record<string, unknown>): string =>
  `(${INTERACT_SOURCE})(${JSON.stringify(req)})`;

/** walker 报回来的一行（`walker.js` 的 `collect`）。 */
type WalkerNode = {
  index: number; nodeId: number; role: string; name: string; w: number; h: number;
  /** `walker.js` 只在判成密码框时**才写**这个键（缺席 = 不是密码框）。 */
  isPassword?: boolean;
};
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

/**
 * 在那个页面的**隔离世界**（`WALKER_WORLD_ID`）里求值 —— 产品自己跑 `walker.js` /
 * `interact.js` 的那个世界。发号表 `__kydogWorld.ids` 与密码记忆 `__kydogWorld.pw`
 * 都挂在那里，主世界（`inPage`）看不见它们，所以「按编号认元素」这条路只有这里走得通。
 *
 * 世界是跟着文档走的、跨调用保留：连着两次调用看到的是同一张发号表。
 * 认 webContents 的规矩与 `inPage` 逐字相同（认不到唯一一个就抛，别静默挑第一个）。
 */
async function inWorld<T>(app: ElectronApplication, needle: string, expr: string): Promise<T> {
  const r = await app.evaluate(async ({ webContents }, a) => {
    const all = webContents.getAllWebContents().filter((w) => !w.isDestroyed());
    const hits = all.filter((w) => w.getURL().includes(a.needle));
    if (hits.length !== 1) return { ok: false as const, urls: all.map((w) => w.getURL()) };
    const value = await hits[0].executeJavaScriptInIsolatedWorld(a.world, [{ code: a.expr }]);
    return { ok: true as const, value: value as unknown };
  }, { needle, expr, world: WALKER_WORLD_ID });
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
  // **预算收在本文件里**：这个 helper 自己要等 30 秒，回到 `runTools` 还有一条
  // 60 秒的 `expect.poll`（合计 ~90s）。用例的默认预算是 `playwright.config.ts` 的
  // 60 秒 —— 装不下，先到的会是用例的墙（实测 58.9s 裸超时），下面那条诊断就永远
  // 说不出口。所以进门自己抬，不靠调用方记得写 `test.setTimeout`。**只抬不降。**
  if (test.info().timeout < 180_000) test.setTimeout(180_000);
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
  // 这句话要成立，用例预算得装得下 30s + 60s —— 进门那一行已经自己抬到 180s 了。
  // 本机实测同一个 30s+60s 结构的两个分支（2026-09-09，临时探针）：
  //  · 180s 预算 → **1.5m** 红，Call Log 是「Timeout 60000ms exceeded while waiting on
  //    the predicate」—— poll 自己到点，那句话真说得出口；
  //  · 默认 60s 预算 → **58.9s** 红，Call Log 变成「Test timeout of 60000ms exceeded」
  //    —— 先到的是用例的墙，poll 永远走不完。
  // 要缩的话缩这 30 秒，别缩预算。
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
if (!SKIP_LIVE && SKIP_PERF) console.warn(`\n[61-browser] 性能那一条跳过：${PERF_SKIP_REASON}\n`);

test.describe('61-browser', () => {
  test.skip(SKIP_LIVE, SKIP_REASON);

  // ── Task 7：真布局回归 ──────────────────────────────────────────────────
  //
  // 前六个任务把功能做完了。这三条守的是单测守不住的那两件事：「祖先对了但按钮被挤
  // 出可视区」（单测断的是 DOM 结构，量不出几何）、「对话栏被挤到 composer 不可见」
  // （单测不挂真窗口，量不出真实宽度）。都要真布局才量得到。

  /**
   * **本轮唯一一处真实回归风险。** 1024 宽窗口 + 侧栏（旧默认 560）会把中栏挤到
   * `composer-input` 不可见、`fill()` 直接超时 —— `61-browser` 这一组因此此前一律
   * 不敢开侧栏（见下面「打真的 extract / click / type」几条的开场注释：「1024 宽的
   * 窗口里再挂一个 560 宽的侧栏会把中栏挤到 composer 不可见」）。`MIN_MAIN_WIDTH`
   * 落地之后它必须不再成立：`rightPane.test.ts` 已经在单测层面钉死
   * `browserWidthFor(null, 756) === 396`（1024 窗口的可用宽），这里在真窗口上验证
   * 那个数字真的能让 composer 用起来。
   *
   * **需要先有一个线程、且线程里已有消息，`composer-input` 才会是「日常那一个」**：
   * `MainPane` 没有 `currentThreadId` 时画的是 `<Welcome />`；刚新建、一条消息都没有的
   * 线程走的是 `ThreadView` 里 `NewThreadEmptyState` 那条分支，它自己的首屏大输入框
   * 带着 80px 的通栏留白（`padding: '64px 80px'`，给宽窗口设计的首屏排版），实测在
   * 360 宽的对话栏下量到的宽只有 ~130——那是这块首屏留白的事，不是 `MIN_MAIN_WIDTH`
   * 要守的那条回归。发一条消息切到 `messages.length > 0` 分支，才是 `spec §8.2` 那些
   * `browser_act` 用例平时真正会用到的那个底部 Composer（`ThreadView.tsx:66-75`）。
   * 这一点简报里的伪代码略掉了，这里照 `03-create-thread.spec.ts` 的现成做法起步
   * （种一个项目、点「新建对话」），再补上「发一条消息切到日常输入框」这一步。
   */
  test('开着浏览器时 composer 仍然可见且填得进字', async () => {
    const projectPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
    await seedSamplePackage(projectPath);
    const launched = await launchKydog({
      seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
    });
    const { page } = launched;
    try {
      await page.getByTestId('new-thread').click();
      const firstComposer = page.locator('[data-testid="composer-input"]');
      await firstComposer.click();
      await firstComposer.type('占个位，切到日常输入框');
      await page.keyboard.press('Enter');
      // `onSend` 先把用户消息乐观地写进本地 store 再发 RPC（`Composer.tsx` 的
      // `onSend`）——`messages.length` 因此立刻变成 1，`ThreadView` 跟着从
      // `NewThreadEmptyState` 切到 `MessageList` 分支，不需要等一轮真实的 run 跑完
      // （后台那次 `thread.send` RPC 会不会成功，这条用例不关心）。
      await expect(page.getByTestId('message-list'), '发完第一条消息应当切到 MessageList 分支')
        .toBeVisible();

      await openSidebar(page);
      await openTab(page, 'https://example.com/');

      // **协议层判据先来一条**：`browserWidthFor` 承诺的就是「对话栏（`[data-pane="main"]`）
      // 不许比 MIN_MAIN_WIDTH 窄」——这是 `Math.min(want, available - MIN_MAIN_WIDTH)`
      // 那一钳直接守的事实，不是靠 composer 的可视宽度去反推（那是**下游的 proxy**：
      // 中栏够不够宽与 composer 具体量出来几像素之间还隔着一层 padding，数值会跟着
      // `Composer.tsx` 的 padding 常量漂）。M14（去掉这一钳）在 e2e 窗口的夹具下会把
      // 中栏从 360 压到 302——这条直接量协议层承诺的那个数，不靠 302 恰好还是否
      // 大于某个凭经验选的阈值。
      const mainBox = await page.locator('[data-pane="main"]').boundingBox();
      expect(mainBox, '对话栏（[data-pane="main"]）必须在场').toBeTruthy();
      expect(mainBox!.width, `对话栏宽度不许小于 MIN_MAIN_WIDTH（${MIN_MAIN_WIDTH}）——`
        + `这正是 browserWidthFor 那一钳要保证的事，实际量到 ${mainBox!.width}`)
        .toBeGreaterThanOrEqual(MIN_MAIN_WIDTH);

      const input = page.locator('[data-testid="composer-input"]');
      // **可见性与可写性要分开断言。** 只断 `toBeVisible()` 的话，一个宽度被挤到 0
      // 但仍在 DOM 里的输入框照样算「可见」；只断 fill 的话，Playwright 会自己滚动到它、
      // 把「用户看不见」这件事掩盖掉。两条一起才说得清「用户真的能用它」。
      await expect(input, '开着浏览器时 composer 必须还看得见 —— 这正是 1024 窗口上栽过的地方')
        .toBeVisible({ timeout: 10_000 });
      const box = await input.boundingBox();
      expect(box?.width ?? 0, 'composer 的可视宽度不能被挤成一条缝').toBeGreaterThan(200);
      // `composer-input` 是 `contentEditable` 的 div（`ComposerEditor.tsx`），不是
      // `<input>`/`<textarea>`——`toHaveValue` 只认表单控件，这里改用 `toHaveText`
      // 断可见文本，判据不变（「真的填得进字」）。
      await input.fill('kydog-e2e-窄模式还能打字');
      await expect(input).toHaveText('kydog-e2e-窄模式还能打字');
    } finally {
      await teardown(launched);
    }
  });

  /**
   * Task 4 删掉了顶部那条单独的标题行（「浏览器 Browser」），标签条升顶、地址栏紧跟
   * 在它下面。`BrowserSidebar.test.tsx` 在挂载层面已经守过「DOM 里没有这几个字」，
   * 这里补的是真布局上的另一半：标签条真的排在地址栏**上面**（不是层叠、不是反过来）。
   */
  test('顶部只有两行：标签条在最上、地址栏在下，标题行不存在', async () => {
    const launched = await launchKydog();
    const { page } = launched;
    try {
      await openSidebar(page);
      const pane = page.locator('[data-pane="browser"]');
      const tabstrip = page.getByTestId('browser-tabstrip');
      const urlbar = page.getByTestId('browser-url');
      await expect(tabstrip, '标签条必须在场').toBeVisible();
      await expect(urlbar, '地址栏必须在场').toBeVisible();

      const paneBox = await pane.boundingBox();
      const tabstripBox = await tabstrip.boundingBox();
      const urlbarBox = await urlbar.boundingBox();
      expect(paneBox, '浏览器面板要有真实几何位置').toBeTruthy();
      expect(tabstripBox, '标签条要有真实几何位置').toBeTruthy();
      expect(urlbarBox, '地址栏要有真实几何位置').toBeTruthy();
      expect(tabstripBox!.y, '标签条必须排在地址栏上面（升顶，不是标题行下面那一档）')
        .toBeLessThan(urlbarBox!.y);

      // **结构判据，不是文本判据。** 下面那条文本判据只认「浏览器 Browser」这个
      // 字面串，换个措辞（比如叫「网页」）加回一行标题，文本判据照样绿。这里断的是
      // 标签条必须是浏览器面板（[data-pane="browser"]）里最靠上的那一块——它的顶边
      // 要贴合面板自己的顶边（面板没有上边框/内边距，允许 1px 取整误差）。上面
      // 不管塞进什么内容，都会把标签条往下推、这条判据就会红。
      expect(Math.abs(tabstripBox!.y - paneBox!.y), '标签条必须是浏览器面板里最靠上的那一块——'
        + `顶边应贴合面板顶边，实测标签条 y=${tabstripBox!.y}，面板 y=${paneBox!.y}`)
        .toBeLessThanOrEqual(1);

      // 「浏览器 Browser」曾经是单独一行标题，Task 4 已经删掉——这条文本判据挡的是
      // 「这句话原样还在」，但**不是唯一判据**：换个措辞的标题行要靠上面那条结构
      // 判据去挡。
      const paneText = await pane.innerText();
      expect(paneText, '侧栏里不该再出现「浏览器 Browser」这行标题').not.toContain('浏览器 Browser');
    } finally {
      await teardown(launched);
    }
  });

  /**
   * `TabStrip.tsx` 的那句注释是这条用例的直接依据：**按钮必须在滚动容器外面** ——
   * 放进去的失败形态是「标签开到第五个之后关不掉侧栏」，而单测断的是 DOM 祖先关系，
   * 看不见「祖先对了但按钮被挤出可视区」这件事，只有真布局量得到。
   *
   * 判据分三段，**前两段才是真正的判据**：
   *  · **默认（未滚动）状态**——这正是那句「标签开到第五个之后关不掉侧栏」描述的
   *    坑本身：用户根本不用手动滚，按钮就已经被挤出侧栏可视区了。这里用
   *    `boundingBox()` 而不是先 `click()` 去量：`click()` 会让 Playwright 自己把
   *    元素滚进视野，「点得到」不等于「用户看得见」，会把这条坑悄悄盖过去。
   *  · **滚动真的发生了**——设置 `scrollLeft` 之后读回来确认它变了。如果
   *    `overflow-x-auto` 被挪到了外层 `browser-tabstrip`，对 `browser-tabscroll`
   *    赋值 `scrollLeft` 会变成静默无效操作，不报错、读回来还是 0；不确认这一条，
   *    后面「滚到最右」状态下的按钮几何是在检查一次没有发生的滚动，抓不住这处
   *    回归——只能碰运气，靠原生滚动条意外拦下点击、把用例憋红在别处。
   *  · **滚到最右之后的按钮几何**（在滚动确认真的发生之后再量）——按钮本来就在
   *    滚动容器外面，滚动标签条本该与它们的位置无关。
   * 最后真的点一下 `browser-close-pane`，作为佐证（不是判据），确认点得到、点了
   * 侧栏真的关了。
   */
  test('标签多到需要横向滚动时，三个按钮仍然点得到', async () => {
    const launched = await launchKydog();
    const { page } = launched;
    try {
      await openSidebar(page);
      for (let i = 0; i < 8; i++) {
        await page.evaluate(() => window.kydog.invoke('browser.newTab'));
      }
      await expect.poll(
        async () => (await page.evaluate(() => window.kydog.invoke('browser.getState'))).tabs.length,
        { message: '连开 8 次 browser.newTab 之后标签数应当是 8' },
      ).toBe(8);

      const scroll = page.getByTestId('browser-tabscroll');
      // 前提要立得住：8 个标签必须真的撑爆了 browser-tabscroll 的可视宽度，
      // 不然下面「按钮仍看得见」这件事就没有被考到（标题就是「标签多到需要横向滚动时」）。
      await expect.poll(
        () => scroll.evaluate((el) => el.scrollWidth > el.clientWidth),
        { message: '8 个标签应当已经超出 browser-tabscroll 的可视宽度' },
      ).toBe(true);

      const pane = page.locator('[data-pane="browser"]');
      const paneBox = (await pane.boundingBox())!;
      const buttonIds = ['browser-new-tab', 'browser-fullscreen', 'browser-close-pane'];

      const assertButtonsInPane = async (when: string) => {
        for (const id of buttonIds) {
          const box = await page.getByTestId(id).boundingBox();
          expect(box, `${when}：按钮 ${id} 应有真实几何位置（不在 DOM 里或被隐藏了）`).toBeTruthy();
          expect(box!.x, `${when}：按钮 ${id} 的左边界必须在侧栏可视范围内`)
            .toBeGreaterThanOrEqual(paneBox.x - 1);
          expect(box!.x + box!.width, `${when}：按钮 ${id} 的右边界不能超出侧栏可视范围`)
            .toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
        }
      };

      await assertButtonsInPane('未滚动（默认状态，这是这条用例的主判据）');

      // 把标签条滚到最右（模拟翻看最后打开的那个标签）。
      //
      // **先确认滚动真的发生了。** 如果 `overflow-x-auto` 被挪到了外层
      // `browser-tabstrip` 上，`browser-tabscroll` 自己就不再是滚动容器——这时对它
      // 设置 `scrollLeft` 是静默无效操作：赋值不报错，读回来还是 0。不确认这一条，
      // 下面「滚到最右」状态下量按钮几何就是在检查一次根本没发生的滚动，几何判据
      // 抓不住这处回归（按钮本就在滚动容器外面，位置本来就不受影响）——用例最终会不会
      // 红全看原生滚动条会不会意外拦下后面的点击，是一种碰运气的红，不是判据自己红的。
      await scroll.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
      const scrollLeftAfter = await scroll.evaluate((el) => el.scrollLeft);
      expect(scrollLeftAfter, '设置 scrollLeft 之后应当真的发生了横向滚动——读回来仍是 0 说明 '
        + 'browser-tabscroll 已经不是真正的滚动容器了（比如 overflow-x-auto 被挪到了别的元素上）')
        .toBeGreaterThan(0);

      // 滚动确认真的发生之后，再量按钮几何：按钮本不在这个滚动容器里，位置不该跟着动。
      await assertButtonsInPane('滚到最右之后');

      // 最后的佐证（不是判据）：真点得到，而且点了侧栏真的关了——判据是上面两条
      // （滚动真的发生 + 滚到最右之后按钮几何仍在面板内），这一步不靠点击超不超时。
      await page.getByTestId('browser-close-pane').click();
      await expect(page.locator('[data-pane="browser"]')).toHaveCount(0);
    } finally {
      await teardown(launched);
    }
  });

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
    test.skip(SKIP_PERF, PERF_SKIP_REASON);
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
   * **平滑滚动的站点上，动作路径照样落得到目标。**
   *
   * 2026-09-10 之前不成立：`measure` 的 `scrollIntoView` 不带 `behavior`，用的是
   * `scroll-behavior` 的计算值 —— **站点说了算**。站点开了平滑滚动时那一下是动画，
   * 而 `scrollIntoView` 不等动画结束就返回，紧接着量到的是动画还没开始的坐标，
   * `measure` 报 `offscreen`，**重试也不自愈**（每次量到另一个中间态）。
   * Scholar / 百度学术这类源都可能命中。修法是把 `behavior: 'instant'` 写死在
   * `measure` 里，把「会不会平滑」从站点手里拿回来。
   *
   * **替身守不住这条**：`interact.test.ts` 的 `El` 只记下 `scrollIntoView` 收到的参数，
   * 它不会动画、也没有视口 —— 参数对不对它守得住，「动画中途量坐标」它量不到。
   * 所以这条必须在真浏览器里，且页面必须**真的开着**平滑滚动。
   *
   * 两条滚动链都考：外层文档（`html{scroll-behavior:smooth}`）与一个自己也开着
   * 平滑滚动的内层 `overflow:auto` 容器 —— 实测 `behavior:'instant'` 把**整条链**
   * 都压成瞬时，不是只压最外层。
   */
  test('站点开了平滑滚动：两条滚动链上的 type 都落到目标身上', async () => {
    const { launched, fixturePath } = await launchWithAgent();
    const { app, page } = launched;
    try {
      const opened = await openTab(page, 'https://example.com/');

      await inPage(app, 'example.com', `(() => {
        document.documentElement.style.scrollBehavior = 'smooth';
        document.body.innerHTML = '';
        // ① 外层链：文档自己滚，目标在 3000 像素以下。
        const tall = document.createElement('div');
        tall.style.cssText = 'position:relative;width:1px;height:6000px';
        const far = document.createElement('input');
        far.id = 'kydog-far';
        far.type = 'text';
        far.setAttribute('aria-label', 'KYDOG远框');
        far.style.cssText = 'position:absolute;left:0;top:3000px;width:200px;height:30px';
        tall.appendChild(far);
        document.body.appendChild(tall);
        // ② 内层链：容器自己在首屏内、自己也开着平滑滚动，目标在容器内容的深处。
        const box = document.createElement('div');
        box.id = 'kydog-box';
        box.style.cssText = 'position:absolute;left:400px;top:100px;width:300px;height:400px;'
          + 'overflow:auto;scroll-behavior:smooth';
        const inner = document.createElement('div');
        inner.style.cssText = 'position:relative;width:280px;height:5000px';
        const deep = document.createElement('input');
        deep.id = 'kydog-deep';
        deep.type = 'text';
        deep.setAttribute('aria-label', 'KYDOG深框');
        deep.style.cssText = 'position:absolute;left:0;top:4000px;width:200px;height:30px';
        inner.appendChild(deep);
        box.appendChild(inner);
        document.body.appendChild(box);
        window.scrollTo({ top: 0, behavior: 'instant' });
        return true;
      })()`);

      // **这条断言是这个用例的地基。** 没有它，「夹具压根没把平滑滚动打开」与
      // 「打开了、而我们把它压住了」长得一模一样 —— 那时这条用例永远绿，
      // 而它本该证明的事情一件都没证明。
      const css = await inPage<{ doc: string; box: string; scrollY: number; boxTop: number }>(
        app, 'example.com', `(() => {
          const box = document.getElementById('kydog-box');
          return {
            doc: getComputedStyle(document.documentElement).scrollBehavior,
            box: getComputedStyle(box).scrollBehavior,
            scrollY: window.scrollY, boxTop: box.scrollTop,
          };
        })()`);
      expect(css.doc, '夹具必须真的把文档的平滑滚动打开 —— 否则这条用例什么也没考').toBe('smooth');
      expect(css.box, '夹具必须真的把内层容器的平滑滚动打开').toBe('smooth');
      expect(css.scrollY, '开考之前文档不能已经滚过').toBe(0);
      expect(css.boxTop, '开考之前内层容器不能已经滚过').toBe(0);

      const res = await runTools(page, fixturePath, [{
        toolCallId: 'tc-smooth',
        name: 'browser_act',
        args: {
          tabId: opened.tabId,
          // **顺序有讲究**：内层那个容器在文档 y=100，把它带进视野会把外层文档又滚回
          // 顶部。所以内层先做、外层后做，最后那两条几何断言量到的才都是「真的滚过」。
          // 反过来写的话 `scrollY` 会落回 0，而那不是回归，是这条用例自己踩了顺序。
          actions: [
            { kind: 'type', selector: '#kydog-deep', text: 'kydog-e2e-内层' },
            { kind: 'type', selector: '#kydog-far', text: 'kydog-e2e-外层' },
          ],
        },
      }]);
      const out = res.get('tc-smooth')!;
      // **这条近乎恒真，别把它当成守门的那一条**：`runBatch` 把动作级失败写成正文里的
      // 「⚠ 第 N 个动作失败：…」，**工具终态仍然是 `ok`** —— 只有工具级抛出（坏 tabId、
      // 没有快照）才 `failed`。实测：拿掉 `behavior:'instant'` 之后这一条照样绿，
      // 红的是下面那条 `not.toContain` 与再下面两条值断言。留着它是为了工具级出事时
      // 能把正文摆出来，不是为了守本条回归。
      expect(out.status,
        `browser_act 工具级不该抛。实际结果开头：${out.text.slice(0, 500)}`).toBe('ok');
      // 回归前这里逐字是：「⚠ 第 1 个动作失败：选择器 "#kydog-deep" 滚进视野之后仍然
      // 落在视口外（坐标 504,4118，视口 1280×800）」——这条才是守门的。
      expect(out.text,
        '结果里不该出现 offscreen 那句诊断 —— 出现了就说明 measure 又在动画中途量坐标了')
        .not.toContain('仍然落在视口外');

      const after = await inPage<{ far: string; deep: string; scrollY: number; boxTop: number }>(
        app, 'example.com', `(() => {
          const box = document.getElementById('kydog-box');
          return {
            far: document.getElementById('kydog-far').value,
            deep: document.getElementById('kydog-deep').value,
            scrollY: window.scrollY, boxTop: box.scrollTop,
          };
        })()`);
      expect(after.far, '外层那个框必须真的收到了字').toBe('kydog-e2e-外层');
      expect(after.deep, '内层那个框必须真的收到了字').toBe('kydog-e2e-内层');
      // 两条链各自都得真的动过 —— 只断言「打上了字」的话，一个不需要滚动就够得着的
      // 夹具也能让这条绿，而「滚进视野」正是被测的那一件事。
      expect(after.scrollY, '外层文档必须真的滚下去了（目标在 3000 像素以下）').toBeGreaterThan(1000);
      expect(after.boxTop, '内层容器必须真的滚下去了（目标在容器内容 4000 像素处）').toBeGreaterThan(1000);
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
   * ## 判据是「这一轮 `measure` 一次都没被调用」——这不是凑数，是这道闸的定义
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
   * （第二道接住了）—— 唯一变的是**`measure` 被发了出去**，页面被它滚了一次。
   *
   * 判据分两条，**2a 是主判据**：
   *  · **2a**：这一轮 `measure` 一次都没被调用。这是协议层事实本身 ——「整批在碰页面
   *    之前就停了」。记号是隔离世界里 `Element.prototype.scrollIntoView` 上的一个
   *    透传计数器（`measure` 是 `interact.js` 里唯一调它的地方，`walker.js` 一次都不调；
   *    世界是隔离的，所以网页自己的脚本再怎么滚也数不进来）。
   *  · **2b**：`window.scrollY` 仍是 0。这是同一件事的**残迹**，接得住 `measure` 以外的
   *    路径。密码框故意放在 3000 像素以下、页面高 5000：闸在原位 → `scrollY` 恒 0；
   *    闸没了 → `scrollIntoView` 把它滚到视口中央。
   *
   * **为什么不能只有 2b**：残迹是可以被抹掉的。在第二道闸抛错之前顺手
   * `window.scrollTo(0, 0)`（一句很像样的 UX 收尾）——第一道闸删掉之后，
   * 这一组 12 条一条不红（实测）。而「调没调过」抹不掉。
   * 这正是项目原则那句：需要拿 proxy 才能得出结论时，回到源头把信号留住。
   *
   * 另外三条不是白写的（它们守的是「整条路还是那条路」，不是这道闸）：
   * 挡下的措辞、按键一个都没落地、`type` 后面那个动作压根没跑（出错即停）。
   *
   * ## 判据 2b 依赖的那句话，由**两条断言**守着 —— 都别删
   *
   * 2a 不依赖任何几何（调没调过与页面长什么样无关）；2b 依赖的是
   * 「闸没了 `measure` 会把它滚过来」，拆开是两件事：
   *  ① `scrollIntoView({block:'center'})` 落在这个夹具的密码框上时，**窗口**真的会滚；
   *  ② `measure` 此刻确实在滚，而且这条路确实走到了 `measure`。
   *
   * **① 直接量，不量它的近似 —— 而且量的必须是 `type` 会碰的那个元素。**
   * 这一条栽过三次，每次都是「拿一个通常恰好一致的东西顶替手上已有的事实」：
   *  · 最早量的是 `#kydog-pw` 的 `getBoundingClientRect().top - innerHeight/2 > 0`
   *    （几何够不够得着）。rect 是**文档坐标**，看不见「到底谁来滚」——
   *    把密码框包进一个自身完全在首屏内的 `overflow:auto` 容器：rect 一点没变、
   *    `scrollIntoView` 去滚那个内层容器、`window.scrollY` 一动不动，12 条一条不红。
   *  · 改成真滚一次之后，找元素用的是 `querySelector('input[aria-label="…"]')`。
   *    那是**属性**选择器不是可及名（`walker.js` 的 `nameOf` 还认 `aria-labelledby` /
   *    `alt` / `title` / `innerText`），也不经发号表 —— 多插一个用 `aria-labelledby`
   *    取到同名、且在首屏内的诱饵密码框：探针绑真框（滚，绿）、`type` 按序号绑诱饵
   *    （不用滚窗口，`scrollY` 恒 0，绿），又是 12 条一条不红。
   *  · 现在走的是**同一条解析路径**：快照那一行的**序号** → 重跑生产源码 `walker.js`
   *    拿到该节点的 `nodeId`（发号表是 WeakMap，跨调用同一个元素同一个号）→ 生产源码
   *    `interact.js` 的 `{op:'measure'}`（`resolve` 反查发号表 → `scrollIntoView`）。
   *    这正是 `type` 里 `resolveTarget → dispatch → interact` 走的那条，一个字不差。
   *    「只有一个同名密码框」也不再是默认：快照文本里那种行**数出来断言正好一条**，
   *    重跑 walker 里同名节点也断正好一个、且序号与快照对得上。
   * 密码框自己的位置、中间多出来的滚动容器、页面整个滚不动、视口比页面还高
   * （`DEFAULT_VIEWPORT_HEIGHT`），任一处让①不成立都**当场红**。
   * 注意①**不是**「密码框在首屏之外」—— 那是充分不必要条件：
   * `scrollIntoView({block:'center'})` 对已经在首屏里的元素照样滚
   * （复审实测：`DEFAULT_VIEWPORT_HEIGHT` 800→4000 时密码框在首屏内，判据 2b 仍然有效）。
   *
   * **② 靠第三轮那条对照动作** —— 拿**同一个 bar 上**的一个**非密码**输入框走一次同样的
   * `type`，断言其后 `scrollY > 0`。②里「这条路确实走到了 `measure`」只有它看得见：
   * ①那条探针自己去调 `interact.js`，绕过了 `browserTools → dispatch` 那一段。
   * （②的另一半「`measure` 此刻确实在滚」现在两条都接得住 —— 探针调的就是真 `measure`。）
   * 同一手法在第一轮里已经用过一次（快照里那行「密码框，值不显示」的对照）。
   *
   * 这两条**产品代码里没有任何东西守着**，`npm test` 也跑不到 e2e：破了不报错，
   * 只是让判据 2b 悄悄变成一条永远绿的死断言。
   *
   * ## 为什么要跑三轮 run
   *
   * `type` 要 `index` + `snapshotId`，而这两样都是**页面上现铸的**（walker 在隔离世界
   * 发号、快照 id 由 `browserService` 现给），剧本却要在建 thread 之前就写好。
   * 所以第一轮先用一个**碰不到页面的动作**（`extract` 一个匹配不到的选择器，走隔离世界、
   * 不经 `dispatch`）换回收尾快照，从里面读出编号与快照 id；第二轮才拿它们去 `type`。
   * 中间不许有任何东西滚页面 —— 第一轮之后也断一次 `scrollY === 0`。
   * ①那条探针**排在两轮之间**（它要用第一轮换回来的那个编号），滚完当场还原并断回 0。
   * 第三轮是上面那条对照动作，**必须排在四条判据之后**：它会把页面滚起来、
   * 也会在页面上落下一次 click，放在前面会把判据 2a / 2b 与判据 4 一起污染。
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
        // 站在同一块地上（它走的是同一条 resolveTarget → dispatch → measure）。
        // 「这个夹具还够不够得着」不靠读这几行样式去推：第一轮快照之后那条
        // pwScrollsWindow 探针**真滚一次**量出来（走的是 type 那条 resolve → measure）
        // —— bar 的 top、密码框自己那一行、中间多出来的滚动容器、页面滚不动，全都一次接住。
        // （这几行注入的是页面里的代码，整段在一个模板字符串里：别写反引号。）
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
      //
      // **数的是「有几条」，不是「有没有」。** `String.match` 不带 `/g` 时静默只回第一条，
      // 而下面 `type` 吃的就是这第一条的序号 —— 页面上一旦出现第二个同名密码框，
      // 「探针量的」与「`type` 去碰的」就可能不是同一个元素，而两边各自都还是绿的
      // （复审 V-LABELLEDBY 实测：多一个用 `aria-labelledby` 取到同名的诱饵，
      // 第一道闸删掉这一组 12 条一条不红）。所以「正好一条」是一条**会红的断言**，
      // 不是一个默认。
      const PW_SNAP_LINE = /\[(\d+)\] textbox "KYDOG密码框" \(密码框，值不显示\)/;
      const pwLines = snapOut.text.match(new RegExp(PW_SNAP_LINE.source, 'g')) ?? [];
      expect(pwLines.length, '快照里叫「KYDOG密码框」且被 walker 标成「密码框，值不显示」的行'
        + `必须**正好一条**，实际 ${pwLines.length} 条。0 条：walker 没把它判成密码框（第一道闸`
        + '的判据就是快照里的 isPassword，没标上根本不会触发），或者上面注入的那份 DOM 改了；'
        + '≥2 条：下面 `type` 取的是第一条的序号，而探针按序号认到的可能是另一条 —— '
        + `两道闸的区分当场作废。结果：${snapOut.text.slice(-1200)}`)
        .toBe(1);
      const pwIndex = Number(snapOut.text.match(PW_SNAP_LINE)![1]);

      // ── **判据 2b 依赖的那句话，当场量它本身**（上面 docblock 的①）────────────
      //
      // 关键是**认元素的路必须与 `type` 是同一条**。`type` 走的是
      // `resolveTarget`（快照里那一行的序号 → 该节点的 `nodeId`）→ `interact.js` 的
      // `resolve`（发号表反查，走 open shadow root）→ `measure`。所以这里也走这条：
      //  · 在**同一个隔离世界**里重跑一遍**生产源码** `walker.js` —— 发号表是 WeakMap、
      //    跨调用保留，同一个元素两次拿到的是同一个 `nodeId`；
      //  · 按名字取到那一个节点，**断言它的序号就是上面 `pwIndex`**（两次扫描对得上，
      //    序号↔元素的对应关系没漂）；
      //  · 拿它的 `nodeId` 调**生产源码** `interact.js` 的 `{op:'measure'}` —— 与
      //    `browserService.dispatch` 在 `type` 里发的那一次逐字相同（含
      //    `{block:'center', inline:'center'}`），不是另写一份 `scrollIntoView`。
      //
      // 从前这里是 `document.querySelector('input[aria-label="…"]')`：那是**属性**选择器，
      // 不是可及名（`walker.js` 的 `nameOf` 还认 `aria-labelledby` / `alt` / `title` /
      // `innerText`），也不经发号表 —— 「量的与碰的是同一个元素」只是恰好成立。
      // 再往前是 `rect.top - innerHeight/2 > 0`，那连「谁来滚」都看不见。
      // **`measure` 到底有没有被调用过 —— 这是协议层事实，`scrollY` 只是它的残迹。**
      // 判据 2 从前只有 2b：看这一轮结束时 `scrollY` 是不是 0。那是「页面被碰过没有」的**残迹**，
      // 不是那件事本身：闸删掉之后，只要有谁把滚动**还原**回去（比如在第二道闸抛错之前
      // 顺手 `window.scrollTo(0, 0)`，一句很像样的 UX 收尾），残迹就没了 —— 实测这一组
      // 12 条一条不红。所以这里直接数那件事本身。
      //
      // 记号装在**隔离世界**的 `Element.prototype.scrollIntoView` 上：`interact.js` 就跑在
      // 那个世界里，而 `measure` 是它**唯一**调 `scrollIntoView` 的地方（`walker.js` 一次都
      // 不调）—— 所以这个计数就是「`measure` 被调了几次」。原样透传，不改行为；装错了的话
      // 下面第三轮那条对照动作（断 `scrollY > 0`）会当场红。**没有动任何产品代码，也没有
      // 加测试专用入口**：与这条用例自己往页面里挂 `__kydogClicks` 监听器是同一类做法。
      const measureCalls = async (): Promise<number> =>
        inWorld<number>(app, 'example.com', 'window.__kydogMeasureSpy.n');
      const resetMeasureCalls = async (): Promise<void> => {
        await inWorld(app, 'example.com', `(() => {
          const W = window;
          if (!W.__kydogMeasureSpy) {
            W.__kydogMeasureSpy = { n: 0 };
            const orig = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function (...args) {
              W.__kydogMeasureSpy.n += 1;
              return orig.apply(this, args);
            };
          }
          W.__kydogMeasureSpy.n = 0;
          return true;
        })()`);
      };
      await resetMeasureCalls();

      const probeSnap = await inWorld<WalkerResult>(app, 'example.com', WALKER_SOURCE);
      const probeHits = probeSnap.nodes.filter((n) => n.name === 'KYDOG密码框');
      expect(probeHits.length, '在隔离世界里重跑 walker，叫「KYDOG密码框」的节点必须**正好一个**，'
        + `实际 ${probeHits.length} 个。这一步与上面数快照文本那一条互为独立证人 ——`
        + '对不上说明这两次扫描看到的页面已经不是同一个了').toBe(1);
      const probeNode = probeHits[0];
      expect(probeNode.index, `重跑 walker 给这个密码框的序号是 ${probeNode.index}，`
        + `而 \`type\` 待会儿要用的是快照里的 ${pwIndex} —— 两次扫描的「序号↔元素」对不上，`
        + '下面这条探针量的就不是 `type` 会去碰的那个元素了').toBe(pwIndex);
      expect(probeNode.isPassword, '重跑 walker 时这个节点必须仍然被判成密码框 ——'
        + '不是的话第一道闸（判据就是快照节点的 isPassword）根本不会触发').toBe(true);

      const probeMeasure = await inWorld<{ ok: boolean; reason?: string; isPassword?: boolean }>(
        app, 'example.com', interactExpr({ op: 'measure', target: { nodeId: probeNode.nodeId } }));
      expect(probeMeasure.ok, '拿 `type` 会用的那个 nodeId 去调生产源码 interact.js 的 '
        + `{op:'measure'}，它却没成功（reason=${probeMeasure.reason ?? '(无)'}）。`
        + "reason='password' 说明密码闸被挪进了 `measure` 内部或它之前 —— 判据 2a（数 measure "
        + '被调了几次）还分得开，但这条探针与判据 2b 的几何前提说不出话了，'
        + '这条用例的说明与实现已经对不上，回来重做；'
        + "reason='stale_node' 说明发号表反查不到这个号（文档换过了）；'not_visible' / "
        + "'offscreen' / 'intercepted' 说明上面注入的那份夹具几何变了；'expired' 说明这次求值"
        + '撞了 `notAfter` 自检 —— 但这条探针的 `interactExpr` **本来就不带 `notAfter`**'
        + '（见它的 docblock），出现它就是调用约定被改过了，先去看那个辅助函数').toBe(true);
      expect(probeMeasure.isPassword, 'measure 回报这个元素不是密码框 —— 那第二道闸'
        + '（`browserService` 判 `m.isPassword`）也不会触发，这条用例测的就不再是密码框').toBe(true);

      const pwScrollsWindow = await inPage<number>(app, 'example.com', 'window.scrollY');
      expect(pwScrollsWindow,
        '第一道闸没了的话，measure 必须真把**窗口**滚起来 —— 这一行就是拿 `type` 会碰的'
        + '那个元素、走同一条 `resolve → measure` 当场滚了一次量出来的。这个数不 > 0 说明'
        + '那句话已经不成立：判据 2b（断 scrollY === 0）会变成一条永远绿的死断言，'
        + '两道密码闸不再区分得开。四种成因，别只按第一种去查：① bar 的 top 或密码框自己'
        + '那一行行内样式挪了，从 scrollY=0 把它居中不再需要下滚（注意不是「挪进首屏」：'
        + '首屏内的元素照样会被居中滚）；② 密码框与 document 之间多了一个滚动容器，'
        + '`scrollIntoView` 滚的是那个容器、不是窗口；③ 页面整个滚不动了（页面高度塌了、'
        + '或者 `body` 被固定住）；④ 视口比页面还高（helpers.ts 的窗口尺寸 / '
        + `DEFAULT_VIEWPORT_HEIGHT）。也可能是 \`measure\` 自己不真滚了（实测 ${pwScrollsWindow}）`)
        .toBeGreaterThan(0);
      // **对照组：那个记号真的数得到 `measure`。** 上面这一次探针正是一次 `measure`，
      // 它必须被记到。数不到的话下面「这一轮 measure 一次都没被调用」就是一条白给的断言
      // ——它会恒真，而恒真的断言什么都不守。
      const probeCalls = await measureCalls();
      expect(probeCalls, `刚刚那一次探针调的就是 interact.js 的 measure，记号数到的却是 ${probeCalls} 次。`
        + '**0 次**说明记号没装到 measure 真正用的那个 Element.prototype 上'
        + '（隔离世界不对？measure 改成不走 scrollIntoView 了？）—— 下面判据 2a 会变成一条'
        + '恒真的死断言。**多于 1 次**说明这一段里还有别的东西在调 measure'
        + '（重跑的那次 walker？夹具自己的脚本？），那 2a 数出来的次数就不再只属于 `type` 那一批，'
        + '它同样说不清').toBe(1);

      // 探针滚过的这一下要自己还回去 —— 下面判据 2b 断的是「一个像素都没滚」。
      await inPage(app, 'example.com', 'window.scrollTo(0, 0)');
      expect(await inPage<number>(app, 'example.com', 'window.scrollY'),
        '上面那条探针滚完必须还原成 0；没回到 0 的话，下面判据 2b 断的就不是'
        + '「一个像素都没滚」了').toBe(0);
      await resetMeasureCalls();

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

      // 2a) **本条的主判据，协议层事实**：第一道闸排在 `dispatch` 调 `interact` 之前，
      //     所以这一轮 `measure` 一次都不该被调用。它不是「页面此刻什么样」的残迹 ——
      //     谁把滚动还原回去都改不了「调过没调过」这件事。
      expect(await measureCalls(),
        '第一道密码闸排在 dispatch 调 interact **之前** —— 它在原位时，这一批连一次 '
        + '`measure` 都不该发出去。数到了说明第一道闸已经不在，挡下它的是第二道'
        + '（measure 回来之后判 m.isPassword）；或者「出错即停」坏了，第 2 个动作'
        + '（click #kydog-marker）自己的 measure 被发了出去 —— 分辨看下面第 4 条判据。'
        + '注意这一条**不看 scrollY**：把页面滚回去改不了这个数').toBe(0);

      // 2b) 同一件事的另一面：页面一个像素都没滚。它接得住 `measure` 以外的路径
      //     （比如别处直接发了滚动），与 2a 互为独立证人 —— 两条都别删。
      expect(await inPage<number>(app, 'example.com', 'window.scrollY'),
        '这一批连一次 measure 都不该发出去（2a），页面自然也不该被滚动一个像素。'
        + '2a 绿而这一条红，说明滚页面的不是 measure —— 别只按第一种去查：'
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

      // ── 第三轮：**对照动作** —— 把判据 2b 剩下那半个前提钉成一条会响的断言 ───
      // 判据 2b 之所以能区分两道闸，靠的是「第一道闸没了的话 measure 真的会把它滚过来」。
      // 这句话拆成两件事，而**产品代码里没有任何东西守着它们**：①「measure 落在
      // 这个密码框上时窗口真的会滚」—— 两轮之间那条 `pwScrollsWindow` 已经拿 `type`
      // 会碰的那个元素真滚了一次；② **这条路确实走到了 measure**。②那条探针看不见
      // （它自己直接调 interact.js，绕过了 browserTools → dispatch 那一段），
      // 所以这里拿**同一个 bar 上**的一个**非密码**输入框走一次同样的 `type`：
      // 它必须把页面滚起来。
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
        + 'scrollIntoView 滚起来。它没滚，说明上面判据 2b（断 scrollY === 0）已经不再'
        + '区分得开两道密码闸 —— 三种可能：① 这条路压根没走到 measure；'
        + '② 这个对照动作自己就没跑成，那这条说的根本不是第一件事；'
        + '③ **产品路独有的那两样出了问题** —— 它比两轮之间那条探针多了 `notAfter`'
        + '（单次求值时限，撞上就 `expired`、一个像素都不滚）与 `selector` 解析'
        + '（探针走的是 nodeId）。**这两样探针身上没有，所以「探针绿、这条红」是它们的'
        + '正常表现，别据此断定探针会先红。**'
        + '「measure 自己不真滚了」「几何/滚动容器变了」这两类才由那条 `pwScrollsWindow` '
        + '探针先接住（它调的就是真 measure、也真滚了一次）。分辨②看下面那条判据，'
        + '它排在后面、这条先红就跑不到：把这一条临时停掉再跑一次即可。'
        + '①③ 两种情形下，判据 2b 都是一条永远绿的死断言')
        .toBeGreaterThan(0);
      expect(await measureCalls(), '**对照组**：同一条 `type` 走非密码框时，`measure` 必须真的'
        + '被调过。这个数是 0 说明这条路压根没走到 measure —— 那上面判据 2a（断 measure '
        + '一次都没被调用）就不是「闸挡住了」的证据，它对任何目标都恒真。'
        + '（这一条与它下面那条 scrollY > 0 分工不同：这条问「走没走到 measure」，'
        + '那条问「measure 走到了、页面也真被它滚了」。）')
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
   * ## 这条用例在**两种**学校上都要跑得过 —— 而且分流键不许是配置
   *
   * `checkLoginHost` 那份判据表里第 1 条与第 3 条**都是正常判据**：**当前标签的** host
   * === entityID 的 host → 直接填；不同 → 问一次并记住（`confirm-then-fill`）。
   * 「entityID 在 `idp.x.edu.cn`、登录页在 `passport.x.edu.cn`」是产品**明确支持**的
   * 形态，不是 `KYDOG_CARSI_LOGIN_URL` 配错了。
   *
   * **分流按 `seen.asked` 走，不按 `entityHost === loginHost` 走。** 产品判的是「填的
   * 那一刻标签实际在哪」，而 `KYDOG_CARSI_LOGIN_URL` 只是 `openTab` 的起点：CAS / WAYF
   * 前置（`sso.x.edu.cn` 302 到 `idp.x.edu.cn`）是 CARSI 里的常见形态，`openTab` 到
   * `browser_login` 之间那几秒足够 302 链跑完 —— 那时配置跨域而标签同域，拿配置去猜
   * 产品走了哪一支就会猜反，红在一条产品完全正确的路上。协议层事实就在手边：
   * `seen.asked`（UI 那一侧看到的「这一轮到底问没问」）。`sameHost` 只用来把失败信息
   * 说得更准，**不当分流键**。
   *
   * 要守的安全属性**不是**「填的 host == entityID 的 host」，而是
   * **「凭据落在了用户实际看到并确认过的那个 host 上」**。它拆成三条：
   *  · **共同判据**：凭据只许落在**协议层允许的那一个 / 那两个 host** 上，证人与产品
   *    自己回显的 `r.host` 相互独立（见下面 `allowedHosts`）。它守的是「`r.host` 报的是
   *    **实际填充那一页**的 host，不是配置、也不是 entityID」。
   *    `checkLoginHost` 那条「返回值不能跨越挂起使用」**不归这条守** —— 这条 e2e
   *    自己不导航，造不出那个前提；守它的是 `loginFlow.test.ts:311-355` 那四条，
   *    每次 `npm test` 都跑。
   *  · **问过了**：产品的回显里必须有「用户刚刚确认了」—— 两个证人对得上。
   *  · **没问**：产品的回显里也不该有「用户刚刚确认了」—— 同上，另一个方向。
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

      const entityHost = hostOfHttpUrl(CARSI.entityID);
      const loginHost = hostOfHttpUrl(CARSI.loginUrl);
      expect(entityHost, 'KYDOG_CARSI_ENTITY_ID 必须是带 host 的 http(s) entityID —— '
        + 'URN 形式的 entityID 上 checkLoginHost 直接拒填（why: entity-has-no-host），'
        + '这条路根本走不到，先把环境变量配对').toBeTruthy();
      expect(loginHost, 'KYDOG_CARSI_LOGIN_URL 必须是一个解析得出 host 的 http(s) 网址 —— '
        + 'openTab 打的就是它，解析不出 host 说明环境变量配错了。'
        + '（顺带：checkLoginHost 对非 https 直接拒填，why: not-https）').toBeTruthy();
      /**
       * **纯措辞用**：配置上这两个 host 同不同。它**不是**分流键 —— 产品按「填的那一刻
       * 标签实际在哪」分支，而 loginUrl 只是 openTab 的起点（302/CAS 前置一跳，两者就
       * 不一样了）。拿它分流会在合法学校上红在一条产品完全正确的路上。
       */
      const sameHost = entityHost === loginHost;

      const opened = await openTab(page, CARSI.loginUrl);
      // **别写成 `let seen = { asked: false, host: null }`**：那个初值会让「没问过」
      // 那一支分辨不出「真的没问」与「duringRun 回调压根没跑」（接线断了照样绿）。
      // 用盒子而不是裸 `let` 是因为 TS 的控制流分析看不见闭包里的赋值，
      // 裸 `let x: T | null = null` 在读的地方会被窄化成 `never`。
      const box: { seen: LoginConfirmSeen | null } = { seen: null };
      const res = await runTools(page, fixturePath, [
        { toolCallId: 'tc-login', name: 'browser_login', args: { tabId: opened.tabId, submit: true } },
        { toolCallId: 'tc-after', name: 'browser_read', args: { tabId: opened.tabId }, afterMs: 20_000 },
      ], async (p) => { box.seen = await confirmLoginPage(p); });
      expect(box.seen, 'confirmLoginPage 一次都没跑过 —— runTools 的 duringRun 接线断了'
        + '（这一轮到底问没问，下面全靠它；没有它就只剩产品自己的回显一个证人）')
        .not.toBeNull();
      const seen = box.seen!;

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
      // 证人按**产品实际走了哪一支**分流（协议层事实 `seen.asked`），不按配置分流 ——
      // 两支各有各的、与产品回显的 `r.host` **相互独立**的证人：
      //  · **问过了** → 证人是那道确认里点名的 host：**用户屏幕上的事实**。
      //  · **没问** → `checkLoginHost` 只有两条 `fill` 出口（`login.ts:161` 与 `:165-169`）。
      //    第 2 条要 `confirmedLogin` 非 null，而 `helpers.ts` 每次 `mkdtemp` 一个
      //    **新 HOME**：机构记录是这一轮刚 `institution.save` 进去的，`confirmedLogin`
      //    开工必为 null，而这一轮又没确认过任何东西（asked=false）也写不进去。
      //    **所以在这条用例里**「填成功了、而且没问」只可能是第 1 条
      //    `host === entityHost` —— 证人是 entityHost。
      //    **这个前提别拆**：谁把这条用例改成复用 HOME、或者提前种一条 confirmedLogin，
      //    这一支的证人就不再成立（`login.ts` 第 2 条出口在 host ≠ entityHost 时
      //    也直接填、也不问）。
      const witnessHost = seen.asked ? seen.host : entityHost;
      expect(witnessHost, seen.asked
        ? '问过了，就必须能从「是」那一项里读出它点名的 host'
          + '（`确认 X 是本校的登录页`，见 loginConfirm.ts）——'
          + 'host 读不出来多半是那句 description 的措辞改了，把这里的正则跟着改'
        : 'entityHost 上面已经断过非空，走不到这里').toBeTruthy();
      // 问过了的那一支，证人是**两个**而不是一个：人在确认框上停留的那段时间里页面可以
      // 自己跳走，`loginFlow` 在填之前会拿当时的 URL **再判一次**（TOCTOU 重判）——
      // 跳到了 entityHost 的话重判走的是第 1 条出口，于是凭据落在 entityHost 上而不是
      // 确认点名的那个，`askedUser` 仍然为真（`loginFlow.test.ts:348` 就断言这一次
      // **填成功**）。那是产品有单测坐实的正确行为，不许在这里判它掉包。
      // 所以判据写成「落在协议层允许的那一个/那两个 host 上」——它正好就是
      // `checkLoginHost` 在这条用例里可能走的全部 `fill` 出口（第 2 条被新 HOME 排除），
      // 落到第三个 host 上照样当场红。
      const allowedHosts = seen.asked && witnessHost !== entityHost
        ? [witnessHost, entityHost] : [witnessHost];
      expect(allowedHosts, '**凭据必须落在协议层允许的 host 上。**'
        + `这一轮实际填在了「${filledHost}」`
        + (seen.asked
          ? `，允许的是「${witnessHost}」（那道确认里点名的、给用户看过的 host）`
            + `或「${entityHost}」（entityID 的 host —— 确认期间页面跳过去了、重判走第 1 条出口）。`
            + '都不是就说明 browser_login 把账号密码填到了一个既没人确认过、也不是 entityID 的域上'
          : `，而这一轮没问，允许的只有「${entityHost}」：checkLoginHost 只在当前 host === `
            + 'entityID 的 host 时才不问就填，而这条用例的新 HOME 里 confirmedLogin 必为 null、'
            + '走不到第 2 条出口。不等就说明凭据填到了一个没人确认过的域上')
        + `（配置上 loginUrl 与 entityID ${sameHost ? '同域' : '跨域'}）`)
        .toContain(filledHost);

      // **两个证人对不对得上**：`r.askedUser` 为真才有「用户刚刚确认了」这一句
      //（`browserTools.ts`），它是产品那一侧「走没走跨域确认」的直接事实；
      // `seen.asked` 是 UI 那一侧的。两边不一致就是接线出了问题。
      // 这里**不**断言「该不该问」——「该不该」由填的那一刻标签在哪决定，
      // 而那一刻的 host 这条用例观测不到（配置里的 loginUrl 不是它）。
      if (seen.asked) {
        expect(login.text, 'UI 上确实弹出过那道确认并被点了「是」，产品的回显里却没有'
          + '「用户刚刚确认了」—— 两个证人对不上，多半是 browserTools 的 askedUser 那一路断了。'
          + '（这里只问「有没有问过」；host 对不对由上面那条 allowedHosts 守。）'
          + (sameHost ? '顺带：配置上是同域却问了，说明标签在 open 与 fill 之间跳走过。' : ''))
          .toContain('用户刚刚确认了');
      } else {
        expect(login.text, 'UI 上一次都没弹出那道确认，产品的回显里却有「用户刚刚确认了」——'
          + '两个证人对不上：要么这一轮真问了而 confirmLoginPage 没看见（那它替谁点的「是」？），'
          + '要么 askedUser 被误置成真。凭据填在哪由上面那条 allowedHosts 守'
          + (sameHost ? '' : '。顺带：配置上是跨域却没问，说明标签在 open 与 fill 之间已经跳到 entityID 的 host 上了'))
          .not.toContain('用户刚刚确认了');
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
 * 第一条硬判据上（复审实测复现过一次：`本次导航耗时 20022ms`）。这条用例一度是
 * `KYDOG_SKIP_LIVE_BROWSER=1` 之后仅剩的一条（那道闸已经从发版流水线上撤掉，
 * 现在那里跑 9 条），一次与产品无关的 DNS 抖动就能阻断整条流水线。
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
