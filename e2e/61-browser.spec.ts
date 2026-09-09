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
 */
async function runTools(
  page: Page, fixturePath: string, calls: ToolCall[],
  duringRun?: (page: Page) => Promise<void>,
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
const CARSI_READY = Object.values(CARSI).every((v) => v !== '');

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
 */
const CARSI_FAILURE_ON = process.env.KYDOG_CARSI_FAILURE_E2E === '1'
  && CARSI_READY && (process.env.KYDOG_CARSI_BAD_PASSWORD ?? '') !== '';

const CARSI_SKIP_REASON =
  'CARSI 正路默认不跑：要 KYDOG_CARSI_E2E=1 外加 KYDOG_CARSI_NAME / _ENTITY_ID / '
  + '_USERNAME / _PASSWORD / _LOGIN_URL 五个凭据变量（临时 HOME 里没有它们就一定跑不了）。'
  + '每跑一次都是一次真的机构登录。';
const CARSI_FAILURE_SKIP_REASON =
  'CARSI 反路默认不跑，而且**与正路分开**开关：要 KYDOG_CARSI_FAILURE_E2E=1 外加'
  + ' KYDOG_CARSI_BAD_PASSWORD。每跑一次就是一次故意的登录失败，而高校 IdP 普遍锁定'
  + '连续失败的账号 —— 押的是用户自己的校园账号。';

/** 首次确认那道是非题（`loginConfirm.ts`）：走的是现成的 ask broker，UI 与提问工具同一套。 */
async function confirmLoginPage(page: Page): Promise<void> {
  await expect(page.getByTestId('question-composer')).toBeVisible({ timeout: 30_000 });
  // 第一个选项就是「是，就在这里登录」——`loginConfirm.ts` **结构地**取 options[0]，
  // 这里按同一个顺序点，不写死文案。
  await page.getByTestId('ask-option-q0o0').click();
  const submit = page.getByTestId('ask-submit');
  if (await submit.count()) await submit.click();
  await expect(page.getByTestId('question-composer')).toHaveCount(0, { timeout: 10_000 });
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

      const opened = await openTab(page, CARSI.loginUrl);
      const res = await runTools(page, fixturePath, [
        { toolCallId: 'tc-login', name: 'browser_login', args: { tabId: opened.tabId, submit: true } },
        { toolCallId: 'tc-after', name: 'browser_read', args: { tabId: opened.tabId }, afterMs: 20_000 },
      ], confirmLoginPage);

      const login = res.get('tc-login')!;
      expect(login.status, `browser_login 应当成功，结果开头：${login.text.slice(0, 300)}`).toBe('ok');
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
 * 一个能打开的源，恰恰相反 —— 一个必然解析不了的名字（`.invalid` 是 RFC 2606 保留的
 * 顶级域，永远不该被解析出来）。断网也照样成立，所以发版流水线上也该跑。
 *
 * 判据是**四分的终态本身**（spec §4.4）：`failed` 带真实的 `errorCode` / `errorDesc`，
 * 不是 `timeout`。两者对模型的处置完全相反 —— 「打不开」可以换源，「不知道发生了什么」
 * 不许据此断定源有问题。顺带把耗时钉住：真走到 `timeout` 那一支要 20 秒
 * （`NAV_TIMEOUT_MS`），所以「远早于 20 秒」是这条终态的独立佐证。
 */
test('61-browser: 打不开的地址回 failed + 真实 errorCode，不是 timeout', async () => {
  const launched = await launchKydog();
  const { page } = launched;
  try {
    const t0 = Date.now();
    const r = await openTab(page, 'https://kydog-e2e-nonexistent.invalid/');
    const ms = Date.now() - t0;
    const o = r.nav.outcome;
    expect(o.kind, `解析不了的名字必须回 failed，实际是 ${o.kind}`).toBe('failed');
    if (o.kind !== 'failed') return;  // 类型收窄，上面那条已经保证了
    expect(o.errorCode, 'errorCode 必须是 Chromium 真给的那个负数网络错误码').toBeLessThan(0);
    expect(o.errorDesc, 'errorDesc 必须是 Chromium 真给的那个名字（ERR_…）').toMatch(/^ERR_/);
    expect(ms, `本次导航耗时 ${ms}ms。走到 timeout 那一支要 20 秒（NAV_TIMEOUT_MS），`
      + '远早于它才说明这是一次明确的网络层拒绝').toBeLessThan(15_000);
  } finally {
    await teardown(launched);
  }
});
