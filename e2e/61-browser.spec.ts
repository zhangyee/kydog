import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown } from './helpers';

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
 * ## 这一份**没有**覆盖到什么（重要，别当成已经守住了）
 *
 * `e2e-requirements.md` 的 E-1a / E-1b / E-4 与 spec §8.2 的第 2、5、6 条，
 * 要动的是 `browserService.dispatch / snapshot / evalInPage` 与
 * `browserTools.runStep`、`loginFlow.fill`。**这几处在生产代码里唯一的调用方
 * 是 `createBrowserTools()`，而它只在 `sessionFactory.createSession()` 的
 * 非 fixture 分支里被构造 —— 那条路要一个真的 LLM。** 而 `app.evaluate` 够不到
 * 它们：`.vite/build/main.js` 是一份 rollup 出来的 CJS 单体 bundle，
 * 对外只导出 `KydogError / broadcaster / getProviderRegistry / loadIndex /
 * logger / resolveActive / threadService` 七个符号（2026-09-09 直接 grep 产物核过），
 * 主进程里既没有 `require` 也没有任何 globalThis 句柄能拿到 `browserService`。
 * 详见 `task-11-report.md`。
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

// **跳过不许是静默的。** `test.skip(cond, reason)` 把原因记成注解，可 list reporter
// 只画一个 `-`，原因要点开 HTML / JSON 报告才看得见 —— 而流水线上没人会去点。
// 所以这里再往运行输出里写一行：谁看日志谁就看得到这一组为什么没跑。
if (SKIP_LIVE) console.warn(`\n[61-browser] 整组跳过（5 条）：${SKIP_REASON}\n`);

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
