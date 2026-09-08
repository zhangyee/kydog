// src/main/agent/browserTools.ts
import { Type } from 'typebox';
import { KydogError } from '../../shared/errors';
import type { NavigationObservation } from '../../shared/types';
import { browserService, WALKER_WORLD_ID } from '../browser/browserService';
import { renderDiff, renderSnapshot, wrapPageContent, type AxSnapshot } from '../browser/snapshot';
import {
  validateBatch, flattenActions, resolveTarget, assertTypeAllowed, keyEventsFor, needsTarget,
  ACTION_KINDS, WAIT_DEFAULT_MS, WAIT_MAX_MS,
  type Action, type TargetSpec, type FlatStep,
} from '../browser/actions';
import {
  compileExtractPlan, extractExpression, describeExtractResult, createBatchBudget, describeCollected,
  type ExtractResult, type ExtractRow, type BatchBudget,
} from '../browser/extract';

type ToolContent = { type: string; [k: string]: unknown };
type ToolResult = { content: ToolContent[]; details?: unknown };

const text = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }] });

/**
 * 标签清单一行，挂在**每个**浏览器工具结果的头部。
 * 这样就不需要一个单独的 browser_tabs 工具 —— 清单总是准的，也不占一个工具位。
 */
function tabsLine(activeId?: string): string {
  const s = browserService.getState();
  if (s.tabs.length === 0) return '标签页: （无）';
  const cur = activeId ?? s.activeTabId;
  return '标签页: ' + s.tabs.map((t) => {
    const host = (() => { try { return new URL(t.url).host; } catch { return t.url || 'about:blank'; } })();
    return `[${t.id}]${t.id === cur ? '*' : ''} ${host}`;
  }).join(' · ');
}

/**
 * 导航结果说人话。每种终态措辞都不同，因为模型对它们的处置不同 ——
 * 尤其是「我们知道发生了什么」的那几种与 timeout 不能混为一谈。
 *
 * **这段文案是模型唯一读得到的东西**：把「被另一次导航接替了」说成「这个源不可用」，
 * 模型就会去换源，而实际上源好好的。所以除了 failed，任何一条都不许出现
 * 「打不开 / 源不可用 / 换个源」这类断言句（要提它，得放进「」里跟它划清界限），
 * 而且每条都要带上自己那个终态的协议事实。守这条的是 browserTools.test.ts。
 *
 * 导出只为让上面那条能被直接钉住 —— 工具的 execute 之外没有别的调用方。
 */
export function describeNav(nav: NavigationObservation): string {
  const o = nav.outcome;
  switch (o.kind) {
    case 'ok':
      return o.httpStatusCode >= 400
        // 403/404 是一次**成功**的导航，页面确实到了、只是内容是拦截页或错误页。
        // 说清状态码，让 skill 的换源规则有协议层依据，而不是去猜页面文案。
        ? `已打开 ${o.finalUrl}，但服务器返回 HTTP ${o.httpStatusCode} —— 页面到了，内容多半是拦截页或错误页。`
        : `已打开 ${o.finalUrl}（HTTP ${o.httpStatusCode}）。`;
    case 'ok_same_document':
      // 同文档导航（hash / pushState / 站内路由）没有 HTTP 响应，文档也没换。
      return `已在同一个文档内跳转到 ${o.finalUrl}（没有新的 HTTP 响应）。页面没有整体换掉，内容多半是脚本改出来的。`;
    case 'failed':
      return `打不开：${o.errorDesc}（错误码 ${o.errorCode}）。这是网络层的明确拒绝。`;
    case 'crashed':
      return `页面进程崩溃了（${o.reason}）。这不是网络层的拒绝，也不说明这个源有问题 —— 重开一次多半就好。`;
    case 'download':
      return `这个地址是一个文件（${o.mimeType}，${o.filename}），不是网页。`
        + '本期浏览器不下载文件，已按策略取消。'
        + '如果它是 arXiv / PMC / DOI，把标识符交给 fastpaper download；否则把链接报给用户。';
    case 'blocked':
      return `这次导航被 KyDog 自己的网址闸拦下了：${o.reason}。这是我们这一侧的策略，**不是**这个源的问题 —— 换一个公网地址再试。`;
    case 'superseded':
      // 「或者页面自己跳走了」删掉了：页面自己跳走走的是 did-navigate，收敛到 ok，
      // 永远到不了这条文案。写进去只会让模型把两件事混在一起推断页面状态。
      return '这次导航在途中被另一次导航接替了（比如用户点了刷新），本次没有结果。页面现在是什么状态由接替的那一次决定 —— 要用就先重新看一眼，别拿这次的结论去推断。';
    case 'cancelled':
      return '这次导航还没有结果，承载它的标签就被关掉了（用户关的，或者这次任务的浏览器被回收了）。这不是这个源的问题 —— 还要继续就重新开一个标签。';
    case 'timeout':
      return '到时限仍没有明确结果，已停止这次导航。**这与「打不开」不是一回事** —— 我们不知道发生了什么，别据此断定这个源有问题。'
        + (o.abortObserved ? '（期间主 frame 被中断过一次 ERR_ABORTED，但始终没有等到后续事实。）' : '');
  }
}

/**
 * 这次导航有没有落到一个**能取快照**的页面上。
 *
 * 写成穷尽 switch 而不是 `kind === 'ok'`：相等比较在 union 变长时会静默漏掉新
 * 成员（`ok_same_document` 就是这么漏的 —— 同文档导航成功了却拿不到新快照，模型
 * 收到「跳转成功」外加零内容，只能再空跑一轮），而穷尽 switch 会 TS2366 红出来
 * 逼人表态。
 *
 * 同文档导航也要取快照：DOM 大体还在不等于视口坐标还在（hash 跳转会滚动页面），
 * 而快照编号里的 x/y/w/h 是视口内的 CSS 像素。
 */
export function landedOnPage(o: NavigationObservation['outcome']): boolean {
  switch (o.kind) {
    case 'ok':
    case 'ok_same_document':
      return true;
    case 'failed':
    case 'crashed':
    case 'download':
    case 'blocked':
    case 'superseded':
    case 'cancelled':
    case 'timeout':
      return false;
  }
}

// ── browser_open ────────────────────────────────────────────────────────────

const OpenParams = Type.Object({
  url: Type.String({ description: '要打开的网址，必须是 http/https' }),
  tabId: Type.Optional(Type.String({ description: '给了就在这个标签里导航；不给就新开一个' })),
});

const OPEN_DESC = [
  '在内置浏览器里打开一个网址，返回页面快照。',
  '',
  '**同一个源的连续页面请复用一个标签**（把上一次返回的 tabId 传回来），',
  '不要每篇论文都新开一个 —— 标签有上限，而且开多了你自己也理不清。',
  '',
  '返回的快照里每个元素带一个编号。那个编号**只在这一份快照里有效**，',
  '页面一变就全部作废；browser_act 里用它必须同时带上 snapshotId。',
].join('\n');

// ── browser_act ─────────────────────────────────────────────────────────────

const TargetProps = {
  selector: Type.Optional(Type.String({ description: 'CSS 选择器。已探明的剧本用这个' })),
  index: Type.Optional(Type.Number({ description: '快照里的编号。探索时用这个，必须同时给 snapshotId' })),
  snapshotId: Type.Optional(Type.String()),
};

/**
 * `kind` 落**字面量白名单**，不是 `Type.String()`。schema 这一层是模型第一眼看到的
 * 契约：写成裸字符串的话，`{kind:'navigate'}` 连 schema 都过得去，模型要等到
 * 主进程校验才知道没有这个动作 —— 而在此之前它已经按自己以为的语义排好了整批剧本。
 * 取值与 `ACTION_KINDS`（spec §4.1 的九种）同一个出处，两边不会漂。
 */
const KindSchema = Type.Union(
  ACTION_KINDS.map((k) => Type.Literal(k)),
  { description: ACTION_KINDS.join(' / ') },
);

/** 导出只为让上面那两条能被直接钉住 —— schema 是模型看到的契约，
 *  而它没有任何别的东西会在退化时报错（改回 `Type.String()` 编译照样过）。 */
export const ActionSchema = Type.Object({
  kind: KindSchema,
  ...TargetProps,
  text: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  key: Type.Optional(Type.String({ description: 'Enter / Tab / Escape / ArrowDown …' })),
  direction: Type.Optional(Type.String()),
  selectors: Type.Optional(Type.Record(Type.String(), Type.String())),
  until: Type.Optional(Type.Any()),
  // 上下界照 spec §5.5 落在 schema 上。没有上限的话，一个 sequential 工具能把
  // 整轮 run 卡满自定的时限（实测 600000 一路通过），用户只看到「操作网页」转圈。
  timeoutMs: Type.Optional(Type.Number({
    minimum: 1,
    maximum: WAIT_MAX_MS,
    default: WAIT_DEFAULT_MS,
    description: `wait 的时限，毫秒。不给就是 ${WAIT_DEFAULT_MS}，上限 ${WAIT_MAX_MS}`,
  })),
  times: Type.Optional(Type.Number()),
  actions: Type.Optional(Type.Array(Type.Any())),
});

const ActParams = Type.Object({
  tabId: Type.String(),
  actions: Type.Array(ActionSchema, { description: '按顺序执行，出错即停' }),
});

const ACT_DESC = [
  '在一个标签里执行一串动作，自动附带页面变化。',
  '',
  '**一次调用装一串动作**，别一个动作发一次 —— 那是四倍的代价。',
  '典型的检索是：click 搜索框 → type 检索词 → click 提交按钮。',
  '',
  '语义是「尽力顺序执行 + 出错即停」：第 k 个动作失败时，前 k-1 个已经生效了，',
  '返回值会说清停在哪、为什么、页面现在什么样。网页本来就不可回滚。',
  '',
  '定位两种：已探明的剧本用 selector；探索时用 index，且必须带产生它的 snapshotId。',
  '',
  '注意 **Enter 不一定能提交表单**，很多站点要点提交按钮。',
  '',
  // 这一行随 Task 4 补完动作派发一起删掉。留着它是因为另一头更贵：
  // 契约里写着 click / type 而派发侧还没接通时，模型只能靠撞一次错误才知道。
  '**当前版本只接通了 key 与 extract**：click / type / hover / select / scroll / wait 会明确报'
  + '「还没有实现」并让这一批停在那里 —— 那是 KyDog 这一侧没做完，不是站点的问题，换源没有用。',
].join('\n');

// ── browser_read ────────────────────────────────────────────────────────────

const ReadParams = Type.Object({ tabId: Type.String() });

const READ_DESC = [
  '读当前页面的正文文本。',
  '',
  '结构化抽取**不在这里** —— 那是 browser_act 的 extract 动作（它能取 href，正文抽取取不到）。',
  '这个工具是给「我要读这篇文章说了什么」用的，不是给「我要这一页 20 条结果的链接」用的。',
].join('\n');

// ── 工厂 ────────────────────────────────────────────────────────────────────

/** run 上下文由 sessionFactory 闭包注入 —— pi 的 ctx 里只有 cwd，没有 KyDog 的 runId。 */
export type BrowserToolDeps = { currentRunId: () => string | null };

const withTabs = (body: string, tabId?: string): ToolResult => text(`${tabsLine(tabId)}\n\n${body}`);

export function createBrowserTools(deps: BrowserToolDeps) {
  const openTool = {
    name: 'browser_open',
    label: '打开网页',
    description: OPEN_DESC,
    promptSnippet: 'browser_open — 在内置浏览器里打开一个网址并返回页面快照',
    parameters: OpenParams,
    executionMode: 'sequential' as const,
    async execute(_id: string, params: { url: string; tabId?: string }): Promise<ToolResult> {
      const { tabId, nav } = await browserService.open({
        url: params.url, tabId: params.tabId, ownerRunId: deps.currentRunId(),
      });
      const parts = [describeNav(nav)];
      // 只有真的到了一个页面才取快照。拿不到内容的时候硬取，只会给一份空快照，
      // 让模型以为「这个页面什么都没有」——而事实是它压根没打开。
      if (landedOnPage(nav.outcome)) {
        const snap = await browserService.snapshot(tabId);
        const r = renderSnapshot(snap);
        parts.push('', `快照 ${snap.snapshotId} · ${snap.title}`, r.text);
      }
      return { ...withTabs(parts.join('\n'), tabId), details: { tabId, nav } };
    },
  };

  const actTool = {
    name: 'browser_act',
    label: '操作网页',
    description: ACT_DESC,
    promptSnippet: 'browser_act — 在网页上执行一串动作（点击/输入/翻页/抽取），自动附带页面变化',
    parameters: ActParams,
    executionMode: 'sequential' as const,
    async execute(_id: string, params: { tabId: string; actions: Action[] }, signal?: AbortSignal): Promise<ToolResult> {
      const before: AxSnapshot | null = browserService.getSnapshot(params.tabId);
      // 校验在排队**之前**：形状不对的一批不该先去占住这个标签的队列。
      validateBatch(params.actions);
      const steps = flattenActions(params.actions);

      // 整批走 `enqueue` + `withAgentDriving`，与 `browser_open` 同一条路
      // （`browserService.ts` 那两处「不要另开一条路」说的就是这里）：
      //  · enqueue —— 渲染层的 browser.navControl / browser.open 走的是另一条路，
      //    两条同时动一个标签时一次导航的事件会被另一次调用消费掉；
      //  · withAgentDriving —— 整批期间 `isAgentActive` 必须为 true，否则动作触发的
      //    `window.open` 新标签会被 `setWindowOpenHandler` 判成用户的，`disposeForRun`
      //    永不回收它，一轮长检索下来标签只增不减。
      return browserService.enqueue(params.tabId, () => browserService.withAgentDriving(
        params.tabId, deps.currentRunId(), () => runBatch(params.tabId, steps, before, signal),
      ));
    },
  };

  const readTool = {
    name: 'browser_read',
    label: '读网页正文',
    description: READ_DESC,
    promptSnippet: 'browser_read — 读当前网页的正文文本',
    parameters: ReadParams,
    executionMode: 'sequential' as const,
    async execute(_id: string, params: { tabId: string }): Promise<ToolResult> {
      // 与 browser_act 同一条路（enqueue + withAgentDriving）：读正文本身不导航，
      // 但它必须与同一个标签上在途的导航串起来 —— 否则读到的是上一页的正文，
      // 而返回值里没有任何东西说得出这件事。
      return browserService.enqueue(params.tabId, () => browserService.withAgentDriving(
        params.tabId, deps.currentRunId(), async () => {
          const wc = browserService.webContentsOf(params.tabId);
          if (!wc) throw new KydogError('browser.no_tab', `没有这个标签页：${params.tabId}`);
          // **隔离世界，不是主世界。** 理由与 extract 那一处一字不差：页面覆写
          // `document.querySelector` / `innerText` 骗得到主世界、骗不到这里
          // （2026-09-08 spike 实测）。这里返回的整页正文同样是模型当事实用的东西 ——
          // 页面只要覆写一个取值器就能决定模型读到哪一段。
          const body = await wc.executeJavaScriptInIsolatedWorld(WALKER_WORLD_ID, [{
            code: '(() => { const m = document.querySelector("main,article"); '
              + 'return (m || document.body).innerText.slice(0, 20000); })()',
          }]) as string;
          return withTabs(wrapPageContent(body), params.tabId);
        },
      ));
    },
  };

  return [openTool, actTool, readTool];
}

/**
 * 跑完一批动作并拼出返回值。整个身体都在 `enqueue` + `withAgentDriving` 里面。
 *
 * 拆成模块级函数只为一件事：`browser_act` 的接线（排队、驱动窗口、收尾快照、预算）
 * 是这个文件里**唯一没有被任何用例碰过**的那一层（最终评审的 C4），拆出来之后
 * browserTools.test.ts 才好把它整条钉住。
 */
async function runBatch(
  tabId: string, steps: FlatStep[], before: AxSnapshot | null, signal?: AbortSignal,
): Promise<ToolResult> {
  const rows: string[] = [];
  const collected: ExtractRow[] = [];
  // 预算跨步骤累计：`collected` 一把 JSON.stringify 进工具结果，而一批允许 60 个
  // 动作 / repeat 10 轮 —— 逐格与逐次的上限都拦不住这一头。
  const budget = createBatchBudget();
  let stoppedAt: string | null = null;

  for (const step of steps) {
    if (signal?.aborted) { stoppedAt = `${step.label}：用户中止`; break; }
    try {
      const line = await runStep(tabId, step.action, collected, budget);
      rows.push(`${step.label}：${line}`);
    } catch (err) {
      const msg = err instanceof KydogError ? err.message : String(err);
      stoppedAt = `${step.label}失败：${msg}`;
      break;
    }
  }

  // **收尾快照要接住。** 它在 try 之外的时候，标签在这一刻已经没了（用户关了侧栏那个
  // 标签、或 disposeForRun 抢在前面）就抛 browser.no_tab，把这一批**已经抽到的数据
  // 一起丢光** —— 与 ACT_DESC 和下面那句注释承诺的「出错即停但已抽到的数据全部返回」
  // 正好相反。
  let after: AxSnapshot | null = null;
  let snapshotFailed: string | null = null;
  try {
    after = await browserService.snapshot(tabId);
  } catch (err) {
    snapshotFailed = err instanceof KydogError ? err.message : String(err);
  }

  const parts = [...rows];
  // 出错即停，但**已经抽到的数据全部返回** —— 翻到最后一页时 click 找不到「下一页」
  // 是预期行为，前几轮的结果不该跟着一起丢。
  if (stoppedAt) parts.push('', `⚠ ${stoppedAt}`, '（此前的动作已经生效，网页不可回滚）');
  // 预算把后面的行全丢光时（收下 0 条）也要说出口，不然那句话跟着数据块一起没了。
  const batch = budget.report();
  if (collected.length || batch.truncated) {
    parts.push('', describeCollected(batch));
    if (collected.length) parts.push(wrapPageContent(JSON.stringify(collected, null, 1)));
  }
  if (after) {
    parts.push('', `── 页面变化（快照 ${after.snapshotId}）──`, renderDiff(before, after).text);
  } else {
    // 「我没取到」与「页面没有变化」绝不许长得一样。
    parts.push('', '── 页面变化 ──',
      `取不到收尾快照：${snapshotFailed}。上面是这一批实际做到的部分；`
      + '页面此刻什么样这一次说不出来 —— 这是**没看到**，**不要**据此断定它没变。');
  }
  return {
    ...withTabs(parts.join('\n'), tabId),
    details: { snapshotId: after?.snapshotId ?? null, stopped: stoppedAt, snapshotFailed },
  };
}

/**
 * 动作派发还没接通的那几种。
 *
 * **绝不以成功措辞返回。** 计划里 `browserTools.ts` 本来是「等 Task 4 补完动作派发
 * 再一起提交」的，那时的 `default` 分支算完目标就 `return \`click → #12\``——
 * 一次都没派发到页面，而返回值读起来是「做过了」。工具一旦先于 Task 4 注册进
 * `sessionFactory`（Task 6 Step 8 不依赖 Task 4），agent 点「搜索」按钮会收到
 * 「第 1 个动作：click → #12」外加「页面没有变化。」，于是判定这个站点的检索入口坏了
 * 并换源，全程零错误。这正是 `actions.ts` 白名单 docblock 逐字描述的失败模式。
 *
 * 措辞里不许出现「打不开 / 这个源不行」那类断言：这是**我们这一侧还没做**，
 * 与站点无关，说错了模型就会去换源。
 */
function notImplemented(kind: string): KydogError {
  return new KydogError('browser.bad_action',
    `${kind} 这个动作还没有实现 —— KyDog 这一侧的动作派发尚未接通，它一个字都没有发到页面上。`
    + '这与站点无关，换源没有用；这一批到此为止，请改用已经能用的动作（key / extract）或换一条路。');
}

/** 执行一个动作，返回一句给模型看的说明。真正碰页面的部分都在这里。 */
async function runStep(
  tabId: string, action: Action, collected: ExtractRow[], budget: BatchBudget,
): Promise<string> {
  const wc = browserService.webContentsOf(tabId);
  if (!wc) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);

  switch (action.kind) {
    case 'key': {
      for (const ev of keyEventsFor(action.key)) {
        await wc.debugger.sendCommand('Input.dispatchKeyEvent', ev);
      }
      return `按下 ${action.key}`;
    }
    case 'extract': {
      const plan = compileExtractPlan(action.selectors);
      // 跑在 walker 那个**隔离世界**里，不是主世界：页面覆写 `document.querySelectorAll`
      // 骗得到主世界、骗不到这里（2026-09-08 spike 实测）。抽取结果是结构化的、
      // 模型会当事实用 —— 一份伪造的「20 条论文」比一份伪造的快照更难被察觉。
      const res = await wc.executeJavaScriptInIsolatedWorld(
        WALKER_WORLD_ID, [{ code: extractExpression(plan) }],
      ) as ExtractResult;
      // 按整批预算收行。收不下的如实报出来 —— 静默丢行与静默截断是同一个毛病。
      const kept = budget.admit(res.rows, collected);
      return describeExtractResult(res, res.rows.length - kept);
    }
    default: {
      // **`needsTarget` 与派发侧必须对上。** `scroll` / `wait` 被 validateBatch 放行、
      // `needsTarget` 也说它们不需要目标，而这里无条件 `resolveTarget` 就必抛，
      // 报的还是另一件事（「这个动作需要一个目标：要么给 selector…」）——
      // 于是 skill 教的翻页剧本 `[click 下一页, wait {selector:'.result'}, extract]`
      // 停在第 2 步，模型去给 wait 加 selector，而 wait 的 selector 在 `until` 里，
      // 怎么加都不对，永远走不出去。`actions.ts:48-51` 逐字写着「派发那一侧要先问这个」。
      if (needsTarget(action)) {
        const target = resolveTarget(action as TargetSpec, browserService.getSnapshot(tabId));
        // **密码硬闸排在「还没实现」前面，这是刻意的。** 它是 `assertTypeAllowed` 的
        // 唯一调用点：放在后面就成了死代码，Task 4 补派发的人不会知道要把它接回来。
        // 而对模型来说「不许往密码框打字」也比「这个动作还没实现」更该先说。
        if (action.kind === 'type') assertTypeAllowed(target);
      }
      throw notImplemented(action.kind);
    }
  }
}
