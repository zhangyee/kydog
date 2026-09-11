// src/main/agent/browserTools.ts
import { Type } from 'typebox';
import { KydogError } from '../../shared/errors';
import type { NavigationObservation } from '../../shared/types';
import { browserService } from '../browser/browserService';
import { renderDiff, renderSnapshot, wrapPageContent, type AxSnapshot } from '../browser/snapshot';
import {
  validateBatch, flattenActions, parseWaitUntil,
  ACTION_KINDS, WAIT_DEFAULT_MS, WAIT_MAX_MS,
  type Action, type FlatStep, type WaitUntil,
} from '../browser/actions';
import {
  compileExtractPlan, extractExpression, describeExtractResult, createBatchBudget, describeCollected,
  type ExtractResult, type ExtractRow, type BatchBudget,
} from '../browser/extract';
import { loginFlow } from '../browser/loginFlow';
import { renderConsole, ZERO_CURSOR, type ConsoleCursor } from '../browser/consoleLog';
import { createLoginAsk } from './loginConfirm';
import type { AskSharedState } from './askUserQuestionTool';

type ToolContent = { type: string; [k: string]: unknown };
type ToolResult = { content: ToolContent[]; details?: unknown };

const text = (t: string): ToolResult => ({ content: [{ type: 'text' as const, text: t }] });

/** 标签标题在清单里的上限。整行会挂在**每个**浏览器工具结果头部，标签多时不能让它把结果撑爆。 */
export const TAB_TITLE_MAX = 40;

/**
 * `browser_tabs` 里每条完整 URL 的显示上限。
 *
 * URL 与标题同一个理由（见 `TAB_TITLE_MAX`）：页面完全可控、长度无上限（query
 * string 可以任意长），标签上限 16 个，一次 `browser_tabs` 不截就能把结果撑爆。
 * 比标题宽很多 —— 这里的 URL 要给模型当 `browser_open` 的参数抄、也要给用户核对，
 * 截太短就失去意义；200 字符覆盖真实检索结果页地址的绝大多数长度，留了远超常见
 * query string 的余量。
 */
export const TAB_URL_MAX = 200;

/** 超出上限就截断并**明确**留下记号（`…`）——「不知道有没有截断」被当成「没有
 *  截断」是本仓已经修过一次的缺陷形态（见 `describeReadTruncation`），这里不重犯。 */
function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 剥掉一个 URL 的 userinfo 段（`https://user:密码@host/` 里 `user:密码` 那一截）。
 *
 * `browser_tabs` 要给模型完整 URL（§1.2：同源两个标签只看 host 分不开，这条设计
 * 不推翻），但 URL 可能整条带着凭据 —— `login.ts` 那句「拒绝理由里一律不回显
 * currentUrl」立的就是这条规矩，这里补上纵深防御。**解析不了就原样回退**：
 * 那是 `about:blank` 之类，本来就没有 userinfo。
 */
export function stripUrlUserinfo(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username === '' && u.password === '') return raw;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * 标签清单一行，挂在**每个**浏览器工具结果的头部。清单总是准的，模型不必另外
 * 调一次 `browser_tabs` 才知道有哪些标签（那个工具是给「先看一眼用户开的标签」
 * 用的，见它自己的 description）。
 *
 * 带上标题：agent 要从这一行**抄 tabId**，只给 host 的话，两个同源标签
 * （比如都在 cnki.net 上）长得一模一样，它没法判断哪个是用户说的那一篇。
 *
 * **`*` 标的是 `s.activeTabId`（侧栏打开时用户会看到的那个），不是这次工具调用
 * 操作的标签。** `browser_act` / `browser_read` / `browser_login` 静默操作用户没在
 * 看的标签是常态（侧栏关着时 agent 照常干活），那时如果把 `*` 标成「被操作的标签」
 * 就是在撒谎。措辞与这里的判据必须是同一件事，见 `TABS_DESC`。
 */
function tabsLine(): string {
  const s = browserService.getState();
  if (s.tabs.length === 0) return '标签页: （无）';
  return '标签页: ' + s.tabs.map((t) => {
    const host = (() => { try { return new URL(t.url).host; } catch { return t.url || 'about:blank'; } })();
    // 标题是给人也是给模型分辨用的：两个同源标签只看 host 分不开。
    // 没有标题就不加那一段 —— 空的破折号只是噪声（新开的空白标签常见这种情况）。
    const title = truncate(t.title.trim(), TAB_TITLE_MAX);
    return `[${t.id}]${t.id === s.activeTabId ? '*' : ''} ${host}${title ? ` — ${title}` : ''}`;
  }).join(' · ');
}

/**
 * 机构登录的状态，挂在**每个**浏览器工具结果的头部（spec §4.6 / Task 7 Step 1）。
 *
 * **不能只挂在 `browser_login` 的返回值里**：`submit: false`（验证码）是常态路径，
 * 断言回传发生在模型自己点完提交之后，那一刻 `browser_login` 早就返回了 ——
 * 不带出来的话，模型永远不知道自己登进去没有，只能去猜页面文案。
 *
 * 没有任何标签有登录状态时**一个字都不加**（回 null），免得给每次工具调用都添一行噪声。
 */
function loginLine(): string | null {
  const notes = browserService.getState().tabs
    .map((t) => ({ id: t.id, note: loginFlow.noteFor(t.id) }))
    .filter((r): r is { id: string; note: string } => r.note !== null);
  if (notes.length === 0) return null;
  return '机构登录: ' + notes.map((r) => `[${r.id}] ${r.note}`).join(' · ');
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
 * 取值与 `ACTION_KINDS`（spec §4.1 的九种加 back/forward/reload 三种，合计十二种）
 * 同一个出处，两边不会漂。
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
  // 与 kind 同一个道理：写成裸字符串的话 `{kind:'scroll'}` 与
  // `{kind:'scroll', direction:'left'}` 连 schema 都过得去，模型要等到主进程校验
  // 才知道自己写的方向不存在 —— 而在此之前它已经按自己以为的语义排好了整批剧本。
  direction: Type.Optional(Type.Union([Type.Literal('up'), Type.Literal('down')], { description: 'scroll 的方向' })),
  amount: Type.Optional(Type.Number({
    minimum: 1,
    description: 'scroll 滚多少 CSS 像素。不给就滚一屏（按页面自己的视口高度算）',
  })),
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
  '几件与你的预期可能不同的事：',
  '- click 之前会自动把元素滚进视野并做一次命中检查；被 cookie 横幅之类的浮层挡住会明确报出来，',
  '  不会静默点空。disabled 的控件也会明确报 —— 翻页到最后一页就是这个样子。',
  '- type 会**先清空**目标框再输入（点进去 → 全选 → 输入），返回值里会写清框里最后是什么。',
  '  清不掉就明确报错、一个字都不打 —— 不会变成「追加在原有内容后面」。',
  '  date / time / month / week / datetime-local 这类**分段选择器**打不进去（实测：',
  '  文本插入对它们完全无效），会明确报错；这一期没有设置它们的动作，改用页面上其他入口。',
  '- JS 驱动的检索与翻页**不产生导航**，click 之后必须跟一个 wait，否则你会在旧内容上继续抽。',
  '',
  '- back / forward / reload 三种不需要目标：后退、前进、重新加载当前标签。',
  '  **没有那一步历史时会明确报错并停下整批**，不会静默地什么都不做。',
  '  要去一个新地址用 browser_open，不是 back。',
].join('\n');

// ── browser_read ────────────────────────────────────────────────────────────

const ReadParams = Type.Object({ tabId: Type.String() });

/**
 * 一次 `browser_read` 最多带回多少字符的正文。
 *
 * 依据与 `extract` 的 `MAX_BATCH_CHARS` 同一条：最坏情况是中文正文，1 字符 ≈ 1 token，
 * 两万字符已经占掉一次工具结果的合理份额。
 *
 * **导出是给两个读者用的**：注入页面的那段表达式（`READ_EXPR`，只有一份，别在别处
 * 再硬写一个数），以及 `slowpaperDocConstants.test.ts`（skill 文档里写的那个数与它对账）。
 */
export const READ_MAX_CHARS = 20_000;

/**
 * 注入页面的那段表达式。**回的是 `{text, total}`，不是裸字符串** ——
 * `total` 是截断**之前**的正文长度，主进程靠它算出 `{truncated, returned, totalKnown}`。
 *
 * 从前这里是 `.innerText.slice(0, 20000)` 直接回字符串：一篇长论文的正文在两万字符处
 * 戛然而止，而返回值一个字都不提。**「文章到此为止」与「我只给了你前两万字」在模型眼里
 * 长得一模一样**，可两者的下一步完全不同（一个可以开始写摘要，一个必须改用 `extract`
 * 按章节取）。spec §5.5 那条「截断一律显式回报」在这里从前是个例外，现在不是了。
 *
 * `total` 在页内**数得出来**（`slice` 之前的 `length` 就在手上），所以 `totalKnown`
 * 必须给 —— 「数不出来才不给这个键」说的是 `extract` 的 `fieldTruncation` 那一种。
 */
const READ_EXPR = '(() => { const m = document.querySelector("main,article"); '
  + 'const t = (m || document.body).innerText; '
  // 不是字符串就回 null，让主进程那一侧明确报出来。**别 `String(t)` 兜底** ——
  // 那会把一份 `undefined` 变成正文里四个字母的 "undefined"，模型读到的是一篇
  // 「内容为 undefined」的文章，而不是「这次没读到」。
  + `return typeof t === 'string' ? { text: t.slice(0, ${READ_MAX_CHARS}), total: t.length } : null; })()`;

/** 截断说人话。**放在边界标记外面** —— 这是我们说的话，不是页面内容。 */
function describeReadTruncation(returned: number, total: number): string | null {
  if (total <= returned) return null;
  return `⚠ 正文已截断：本页正文共 ${total} 字符，这里只有开头的 ${returned} 字符`
    + `（一次最多 ${READ_MAX_CHARS}）。**后面那一段不在下面这个框里** —— `
    + '不要据此断定文章到此为止。要后半部分就用 browser_act 的 extract 按章节选择器取。';
}

const READ_DESC = [
  '读当前页面的正文文本。',
  '',
  '结构化抽取**不在这里** —— 那是 browser_act 的 extract 动作（它能取 href，正文抽取取不到）。',
  '这个工具是给「我要读这篇文章说了什么」用的，不是给「我要这一页 20 条结果的链接」用的。',
  '',
  `一次最多带回 ${READ_MAX_CHARS} 字符；超出会**明确说出来**（截了多少、本页共多少）。`,
].join('\n');

// ── browser_login ───────────────────────────────────────────────────────────

const LoginParams = Type.Object({
  tabId: Type.String({ description: '机构登录页所在的标签' }),
  submit: Type.Optional(Type.Boolean({
    description: '填完是否立刻提交表单。**不给就是不提交**（只填，你自己再点提交）',
  })),
  usernameIndex: Type.Optional(Type.Number({
    description: '快照里账号框的编号。不给就按结构规则找（同一个 form 里排在密码框之前的最后一个可见文本框）',
  })),
  snapshotId: Type.Optional(Type.String({ description: '给了 usernameIndex 就必须同时给产生它的 snapshotId' })),
});

/**
 * `browser_login` 的说明。**机构名与 entityID 拼进去**（裁决 7b）——
 * 不放的话模型压根不知道用户是哪所学校，写不出 CARSI 的登录 URL，整条路走不通。
 *
 * **只放机构名与 entityID，绝不放账号与密码。** entityID 是公开清单
 * （`fsso.cnki.net/idp/list`）里的公开标识符，不是秘密；账号与密码则一个字都不进
 * 模型上下文（密码连主进程之外都不出，见 `loginFlow.ts`）。
 *
 * **它是建会话那一刻的快照，用户中途改机构就陈旧了。** 处置写在下面那段文案里：
 * 判据一侧永远不受影响（`loginFlow` 每次执行都重读设置，用的是**当前**的
 * entityID），而这里这份只用于让模型写得出登录 URL；每一次调用的返回值（成功与
 * 失败都算）都会回显**当前**的机构名与 entityID，模型据此自我纠正。陈旧的后果因此
 * 只有一种：模型第一次导到了上一所学校的登录页，然后被 `browser.idp_host_mismatch`
 * 响亮地拒掉并当场读到正确的 entityID —— 不会静默地把密码填错地方。
 */
function loginDesc(inst: { name: string; entityID: string } | null): string {
  return [
    '用设置里存的机构账号，在当前这个机构登录页上填入账号与密码（**密码由主进程直接填，你看不到也拿不到**）。',
    '',
    inst
      ? `当前配置的机构：${inst.name}，entityID：${inst.entityID}`
      : '设置里**还没有配置机构账号** —— 现在调这个工具只会失败，先让用户去设置里配。',
    '（这一行是这次会话开始时的快照。用户中途换了学校它就旧了 ——'
    + '**每次调用的返回值里都会回显当前的机构名与 entityID，以那个为准**。）',
    '',
    '几件必须知道的事：',
    '- 只在**这个机构自己的**统一身份认证页上才填得成。第一次遇到一个新地址会停下来问用户一次；'
    + '用户确认过的地址会被记住，之后不再问。',
    '- **同一轮任务里失败一次就停手**：填过一次而没有看到登录成功的信号，再调只会被拒。'
    + '高校的统一身份认证会锁定连续失败的账号，押的是用户自己的校园账号 —— 那时请交给用户自己登录。',
    '- 成功与否**不看页面文案，也不看状态码**，只看协议事实：SAML 断言有没有回传给论文站。'
    + '看到了以后，每个浏览器工具结果的头部都会有一行「机构登录: …已看到 SAML 断言回传」。',
    '- 有验证码的页面用 `submit` 不给（默认不提交）：先填好账号密码，你再自己填验证码、点提交按钮。',
    '- 账号框由你来指最准：先取一份快照，把账号框的编号用 `usernameIndex` + `snapshotId` 给我。'
    + '不指我也会按结构规则找一个，并在返回值里回显实际选中的是哪个框 —— **看一眼它对不对**。',
    '- 密码框我自己找，只认「此刻就是密码框」或「这个文档里曾经是」；多于一个就整条拒绝，不猜。',
  ].join('\n');
}

// ── browser_tabs ────────────────────────────────────────────────────────────

const TabsParams = Type.Object({});

const TABS_DESC = [
  '列出内置浏览器里当前打开的所有标签页。不碰页面，没有任何副作用。',
  '',
  '**这里面也有用户自己打开的标签** —— 用户可能已经手动找到了要看的那一页，',
  '那一页往往就是最重要的输入。要对某一页动手，把它的 tabId 抄进 browser_open /',
  'browser_act / browser_read / browser_login。',
  '',
  '带 * 的是侧栏当前显示的那个标签（用户打开侧栏时看到的就是它）——',
  '不是「用户此刻正看着」：侧栏关着的时候没有人在看，那时 agent 多半正在静默干活。',
].join('\n');

// ── 工厂 ────────────────────────────────────────────────────────────────────

/** run 上下文由 sessionFactory 闭包注入 —— pi 的 ctx 里只有 cwd，没有 KyDog 的 runId。 */
export type BrowserToolDeps = {
  currentRunId: () => string | null;
  /**
   * `browser_login` 的首次确认要走**现成的** ask broker，这两个照
   * `createAskUserQuestionTool` 的形态由 `sessionFactory` 注入
   * （`threadId` 即 sessionId；`askShared` 是工具 → AgentService 的上行通道）。
   *
   * **必填，没有默认值。** 给个默认（比如「问不了就当用户同意」）等于把 spec §4.6
   * 那道确认变成摆设，而且不会有任何一条用例红。
   */
  threadId: string;
  askShared: AskSharedState;
  /**
   * 建会话那一刻的机构快照，**只用来拼 `browser_login` 的 description**
   * （见 `loginDesc` 那段：为什么放、为什么陈旧了也不危险）。没配就是 null。
   */
  institution: { name: string; entityID: string } | null;
};

/**
 * 「上一次报告之后，这个标签上发生过一次没有人在等的主 frame 导航」，挂在**每个**
 * 浏览器工具结果的头部。
 *
 * 与 `loginLine` 完全同一个理由：**这件事的到达时刻在造成它的那次工具调用返回之后**。
 * `browser_act` 一步都不等 —— 点了检索的提交按钮就返回，结果页的 HTTP 状态码要晚一个
 * 往返才落地。不挂出来的话，Google Scholar 那条最要紧的路上（首页 200、**搜索才 403**）
 * 模型永远拿不到状态码，只能去猜拦截页的正文 —— 而 skill 明写着不许猜正文。
 *
 * `describeNav` 是措辞的**唯一出处**：这一行与 `browser_open` 那一行读起来必须是同一句话，
 * 不然 skill 要为「403 长什么样」写两份判据。
 *
 * 没有未报的导航就**一个字都不加**（回 null），免得给每次工具调用添一行噪声。
 */
function navLine(): string | null {
  const rows = browserService.getState().tabs
    .map((t) => ({ id: t.id, nav: browserService.takeUnreportedNav(t.id) }))
    .filter((r): r is { id: string; nav: { url: string; httpStatusCode: number } } => r.nav !== null);
  if (rows.length === 0) return null;
  return '导航: ' + rows.map((r) => `[${r.id}] ${describeNav({
    navigationId: '',
    outcome: { kind: 'ok', finalUrl: r.nav.url, httpStatusCode: r.nav.httpStatusCode },
  })}`).join(' · ');
}

const withTabs = (body: string): ToolResult => {
  const login = loginLine();
  const nav = navLine();
  return text(`${tabsLine()}${login ? `\n${login}` : ''}${nav ? `\n${nav}` : ''}\n\n${body}`);
};

/** 排队之前先确认标签在。见 `browser_act` 那一处的注释：`enqueue` 只增不减。 */
function assertTabExists(tabId: string): void {
  if (!browserService.getState().tabs.some((t) => t.id === tabId)) {
    throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
  }
}

export function createBrowserTools(deps: BrowserToolDeps) {
  const openTool = {
    name: 'browser_open',
    label: '打开网页',
    description: OPEN_DESC,
    promptSnippet: 'browser_open — 在内置浏览器里打开一个网址并返回页面快照',
    parameters: OpenParams,
    executionMode: 'sequential' as const,
    async execute(_id: string, params: { url: string; tabId?: string }): Promise<ToolResult> {
      // 复用已有标签时要从**当前**位置起算；新开的标签之前什么都没有，从零起算。
      // （新标签的 id 要等 open() 回来才知道，那时页面加载期间的错误已经发生了。）
      const consoleFrom = params.tabId === undefined
        ? ZERO_CURSOR
        : browserService.consoleCursor(params.tabId);
      const { tabId, nav } = await browserService.open({
        url: params.url, tabId: params.tabId, ownerRunId: deps.currentRunId(),
      });
      const parts = [describeNav(nav)];
      // 只有真的到了一个页面才取快照。拿不到内容的时候硬取，只会给一份空快照，
      // 让模型以为「这个页面什么都没有」——而事实是它压根没打开。
      //
      // **快照要接住**，与 browser_act 那一处是同一个失败形状：标签在这一刻已经没了
      // （用户关了它、或 disposeForRun 抢在前面）就抛 browser.no_tab，把**已经拿到的
      // 导航结论一起丢掉** —— 而 describeNav 那句话（尤其 timeout / superseded /
      // blocked 几条）是模型唯一读得到的协议事实。
      if (landedOnPage(nav.outcome)) {
        try {
          const snap = await browserService.snapshot(tabId);
          const r = renderSnapshot(snap);
          parts.push('', `快照 ${snap.snapshotId} · ${snap.title}`, r.text);
        } catch (err) {
          const why = err instanceof KydogError ? err.message : String(err);
          parts.push('', `导航结论如上，但取不到页面快照：${why}。`
            + '这是**没看到**，不要据此断定页面是空的。');
        }
      }
      const con = renderConsole(browserService.consoleSince(tabId, consoleFrom));
      if (con) parts.push('', con);
      return { ...withTabs(parts.join('\n')), details: { tabId, nav } };
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
      // 标签存不存在也在排队**之前**查：`enqueue` 无条件往 `queues` 里塞一个键，
      // 而清理只在真标签的回收路径上 —— 模型手滑写错一个 tabId 就留一个永不删除的
      // 条目（那行注释立的规矩是「只增不减」不许发生）。顺带把错误提前到一句
      // 「没有这个标签页」，而不是让整批跑到派发时才逐条报错。
      assertTabExists(params.tabId);
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
        params.tabId, deps.currentRunId(),
        // **`before` 快照取在队列里面**：这一批在队列里等的那段时间，同一个标签上
        // 另一次操作可能产生新快照，拿队列外那一份去 diff 就会把别人的改动算进
        // 这一批的「页面变化」。控制台游标同一个理由，与 `before` 快照同一处取。
        () => runBatch(
          params.tabId,
          browserService.getSnapshot(params.tabId),
          browserService.consoleCursor(params.tabId),
          steps, signal,
        ),
        '操作网页',
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
      assertTabExists(params.tabId);
      return browserService.enqueue(params.tabId, () => browserService.withAgentDriving(
        params.tabId, deps.currentRunId(), async () => {
          // **隔离世界，不是主世界。** 理由与 extract 那一处一字不差：页面覆写
          // `document.querySelector` / `innerText` 骗得到主世界、骗不到这里
          // （2026-09-08 spike 实测）。这里返回的整页正文同样是模型当事实用的东西 ——
          // 页面只要覆写一个取值器就能决定模型读到哪一段。
          //
          // **走 `evalInPage` 而不是自己拿 `webContentsOf()` 注**：崩过一次的标签上
          // `getOSProcessId()` 回 0 而 `isDestroyed()` 仍是 false，那时求值**永不
          // settle**（实测 3 秒内无任何结果）—— 而这是个 sequential 工具，
          // 挂住就是整轮 run 永远不返回。那个入口自带 pid 闸与单次求值时限。
          const raw = await browserService.evalInPage(params.tabId, READ_EXPR);
          const r = raw as { text?: unknown; total?: unknown } | null;
          // **形状不对就明确报错，不静默把它当正文交出去。** 退回裸字符串（这个工具
          // 从前的形态）时 `total` 无从得知，而「不知道有没有截断」被当成「没有截断」
          // 正是这条缺陷本身 —— 那不是一句不好看的话，是模型据以判断文章完没完的依据。
          if (!r || typeof r !== 'object' || typeof r.text !== 'string' || typeof r.total !== 'number') {
            throw new KydogError('browser.page_no_result',
              '读正文这一步没有拿到认得出的结果 —— **这一页的正文这次说不出来**（不是「这一页没有正文」）。'
              + '多半是求值中途页面导航走了，先取一份快照看页面现在什么样，再决定要不要重来。',
              undefined, 'unknown');
          }
          const note = describeReadTruncation(r.text.length, r.total);
          return withTabs((note ? `${note}\n\n` : '') + wrapPageContent(r.text));
        },
        '读网页正文',
      ));
    },
  };

  const tabsTool = {
    name: 'browser_tabs',
    label: '列出标签页',
    description: TABS_DESC,
    promptSnippet: 'browser_tabs — 列出内置浏览器当前打开的所有标签（含用户自己开的）',
    // **不声明 executionMode。** 它不进队列、不碰页面，没有任何要串行的理由；
    // 声明了就必须同步登记进 askSequentialTools.ts 的 SEQUENTIAL_TOOL_NAMES
    // （那份名单的双向比对会红）。
    parameters: TabsParams,
    async execute(): Promise<ToolResult> {
      const s = browserService.getState();
      const body = s.tabs.length === 0
        ? '现在没有打开任何网页。要开就用 browser_open。'
        // URL 与标题各截各的上限（`TAB_URL_MAX` / `TAB_TITLE_MAX`，见它们自己的注释），
        // 且渲染前剥掉 URL 的 userinfo 段（`stripUrlUserinfo`）——完整 URL 是刻意的
        // （同源两个标签只看 host 分不开），但一条都不许带着凭据进模型上下文。
        : s.tabs.map((t) => `[${t.id}]${t.id === s.activeTabId ? '*' : ''} `
          + truncate(stripUrlUserinfo(t.url), TAB_URL_MAX)
          + (t.title.trim() ? ` — ${truncate(t.title.trim(), TAB_TITLE_MAX)}` : '')).join('\n');
      return withTabs(body);
    },
  };

  const ask = createLoginAsk(deps.threadId, deps.askShared);

  const loginTool = {
    name: 'browser_login',
    label: '机构登录',
    description: loginDesc(deps.institution),
    promptSnippet: 'browser_login — 用设置里存的机构账号在机构登录页上登录（密码由主进程填）',
    parameters: LoginParams,
    executionMode: 'sequential' as const,
    async execute(
      toolCallId: string,
      params: { tabId: string; submit?: boolean; usernameIndex?: number; snapshotId?: string },
      signal?: AbortSignal,
    ): Promise<ToolResult> {
      // 与另外两个工具同一条规矩：标签存不存在在**排队之前**查（`enqueue` 只增不减），
      // 而且这一条要排在问用户**之前** —— 一个写错的 tabId 不该先弹一个确认框给用户。
      assertTabExists(params.tabId);
      const r = await loginFlow.fill(params.tabId, {
        runId: deps.currentRunId(),
        // **不给就是不提交 —— 这是一处对 spec 的有意偏离，别照 spec 改回来。**
        //
        // `spec §4.6` 白纸黑字写的是「`submit` 默认 `true`」，这里刻意用 `false`
        // （控制者 2026-09-09 裁决：接受 `false`；报告 §12 有同一份登记）。理由：
        // spec 自己在同一节写明「`submit: false`（验证码）是常态路径，不是边角情况」，
        // 而两个方向的代价不对称 —— 多提交一次会在有验证码的页面上送出一次必然失败的
        // 登录，而「同一轮失败一次就停手」意味着那是本轮唯一的机会（高校 IdP 还会为
        // 连续失败锁账号）；少提交一次只是让用户多点一下提交按钮，随时补得回来。
        // 所以 fail-safe 的方向是不提交。
        submit: params.submit === true,
        usernameIndex: params.usernameIndex,
        snapshotId: params.snapshotId,
        // 标签 id 在这里绑上：`LoginAsk` 那个口子刻意只描述「问什么」，
        // 不该知道 toolCallId / tabId 这些调用现场的东西。
        ask: (a) => ask(toolCallId, { ...a, tabId: params.tabId }, signal),
      });
      const parts = [
        `已在 ${r.host} 填入「${r.institutionName}」的机构账号与密码。`,
        // 每次调用都回显**当前**的机构 —— description 里那份是建会话时的快照，
        // 用户中途换了学校就旧了（见 loginDesc 那段）。这一行是模型纠正它的唯一途径。
        `当前机构：${r.institutionName}，entityID：${r.entityID}`,
        `实际填的账号框：${r.field}（${r.source === 'model' ? '你用 usernameIndex 指的' : '按结构规则找到的'}）`
        + ' —— **确认一下它是不是账号框**，不是的话别再调这个工具，先告诉用户。',
      ];
      if (r.askedUser) parts.push(`用户刚刚确认了 ${r.host} 是这所学校的登录页，已经记住，以后不再问。`);
      parts.push(r.submitted
        ? '已经请求提交这个表单。**「请求提交」不等于「登录成功」** —— 表单自带的校验可能把它挡下来，'
          + '密码错也会走到一个看起来很正常的页面。等一下再取快照看，'
          + '而真正的成功判据只有一个：工具结果头部出现「已看到 SAML 断言回传」。'
        : '**没有提交**（你没给 submit: true）。页面上现在填好了账号与密码 —— '
          + '有验证码就先填验证码，然后用 browser_act 点提交按钮。'
          + '提交之后留意工具结果头部那行「机构登录: …」，它是唯一的成功判据。');
      return { ...withTabs(parts.join('\n')), details: { tabId: params.tabId, submitted: r.submitted } };
    },
  };

  return [openTool, tabsTool, actTool, readTool, loginTool];
}

/**
 * 跑完一批动作并拼出返回值。整个身体都在 `enqueue` + `withAgentDriving` 里面。
 *
 * 拆成模块级函数只为一件事：`browser_act` 的接线（排队、驱动窗口、收尾快照、预算）
 * 是这个文件里**唯一没有被任何用例碰过**的那一层（最终评审的 C4），拆出来之后
 * browserTools.test.ts 才好把它整条钉住。
 */
async function runBatch(
  tabId: string, before: AxSnapshot | null, consoleFrom: ConsoleCursor,
  steps: FlatStep[], signal?: AbortSignal,
): Promise<ToolResult> {
  // spec §5.1：**这一批里新开的标签必须列出来**。不列的话模型点了一下、返回值说
  // 「成功」，而内容出现在一个它不知道存在的标签里 —— 接下来它会对着旧标签继续操作，
  // 一整轮检索都在一个没变的页面上跑。判据是两次标签清单的差集，协议层现成的事实。
  const tabsBefore = new Set(browserService.getState().tabs.map((t) => t.id));
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
  const opened = browserService.getState().tabs.filter((t) => !tabsBefore.has(t.id));
  if (opened.length) {
    parts.push('', `这一批里新开了 ${opened.length} 个标签页（多半是 target=_blank 的链接）：`
      + opened.map((t) => `[${t.id}] ${t.url}`).join(' · ')
      + '。要操作它里面的内容，把 tabId 换成它。');
  }
  // 预算把后面的行全丢光时（收下 0 条）也要说出口，不然那句话跟着数据块一起没了。
  const batch = budget.report();
  if (collected.length || batch.truncated) {
    parts.push('', describeCollected(batch));
    if (collected.length) parts.push(wrapPageContent(JSON.stringify(collected, null, 1)));
  }
  // 页面自己报的错。**放在「页面变化」之前** —— 它多半就是「点了没反应」的原因，
  // 模型该先读到它再看 diff。
  const con = renderConsole(browserService.consoleSince(tabId, consoleFrom));
  if (con) parts.push('', con);
  if (after) {
    parts.push('', `── 页面变化（快照 ${after.snapshotId}）──`, renderDiff(before, after).text);
  } else {
    // 「我没取到」与「页面没有变化」绝不许长得一样。
    parts.push('', '── 页面变化 ──',
      `取不到收尾快照：${snapshotFailed}。上面是这一批实际做到的部分；`
      + '页面此刻什么样这一次说不出来 —— 这是**没看到**，**不要**据此断定它没变。');
  }
  return {
    ...withTabs(parts.join('\n')),
    details: { snapshotId: after?.snapshotId ?? null, stopped: stoppedAt, snapshotFailed },
  };
}

/** `wait` 等的是哪一件事，说人话。超时那句话要靠它说清楚「没成立的是哪个条件」。 */
function describeWaitUntil(until: WaitUntil): string {
  return 'urlMatches' in until
    ? `地址里出现 ${JSON.stringify(until.urlMatches)}`
    : `选择器 ${JSON.stringify(until.selector)} 在页面上${until.state === 'absent' ? '消失' : '出现'}`;
}

/**
 * 执行一个动作，返回一句给模型看的说明。
 *
 * **真正碰页面的部分不在这里**，在 `browserService.dispatch` —— spec §4.2 的三件事
 * （滚进视野 / 在派发那一刻重新量坐标 / 命中检查）与两道闸（渲染进程、密码框）都在那里。
 * 这一层只做两件它自己的事：`extract` 要整批预算（跨步骤累计，dispatch 看不到），
 * `wait` 要把「条件未达成」翻译成一次动作失败。
 */
async function runStep(
  tabId: string, action: FlatStep['action'], collected: ExtractRow[], budget: BatchBudget,
): Promise<string> {
  if (action.kind === 'extract') {
    const plan = compileExtractPlan(action.selectors);
    // 跑在 walker 那个**隔离世界**里，不是主世界：页面覆写 `document.querySelectorAll`
    // 骗得到主世界、骗不到这里（2026-09-08 spike 实测）。抽取结果是结构化的、
    // 模型会当事实用 —— 一份伪造的「20 条论文」比一份伪造的快照更难被察觉。
    //
    // 与 `browser_read` 同一个理由走 `evalInPage`：崩过一次的标签上求值永不 settle，
    // 而 extract 是这一批里唯一**不经过 `dispatch`** 的动作 —— 那道 pid 闸够不着它。
    const res = await browserService.evalInPage(tabId, extractExpression(plan)) as ExtractResult;
    // 按整批预算收行。收不下的如实报出来 —— 静默丢行与静默截断是同一个毛病。
    const kept = budget.admit(res.rows, collected);
    return describeExtractResult(res, res.rows.length - kept);
  }

  if (action.kind === 'wait') {
    // `until` 的形态在 validateBatch 里已经查过一遍（整批跑起来之前）。这里再解析一次
    // 是因为**类型上它是 unknown**：解析结果才是 waitFor 认得的那个判据。
    const until = parseWaitUntil(action.until);
    const timeoutMs = action.timeoutMs ?? WAIT_DEFAULT_MS;
    const ok = await browserService.waitFor(tabId, until, timeoutMs);
    if (ok) return `等到了：${describeWaitUntil(until)}`;
    // spec §4.2：「超时只表示条件未达成，不表示别的；它是一个动作失败，按出错即停处理」。
    // 措辞不许把它说成页面或站点的问题 —— 说错了模型会去换一个好好的源。
    throw new KydogError('browser.wait_timeout',
      `等了 ${timeoutMs} 毫秒，条件仍未达成（等的是：${describeWaitUntil(until)}）。`
      + '这只说明这个条件没有成立 —— 它不是页面出错，也不是站点的问题。'
      + '要么条件写得不对，要么这一步本来就没有触发页面变化。');
  }

  if (action.kind === 'back' || action.kind === 'forward' || action.kind === 'reload') {
    // **不走 navControl**：整批已经在 `enqueue(tabId, …)` 里面了，而 navControl 自己
    // 也 enqueue 同一个 tabId —— 同标签重入会死锁。historyNav 是不排队的那一半。
    const nav = await browserService.historyNav(tabId, action.kind);
    // null = `canGoBack()` / `canGoForward()` 说没有这一步历史，一次导航都没发起。
    // **不许静默继续**：后退没成而后面的动作照跑，等于让模型在一个它以为已经离开的
    // 页面上继续操作，且不报任何错（spec §2.2）。
    if (nav === null) {
      throw new KydogError('browser.no_history',
        `这个标签上没有可以${action.kind === 'back' ? '后退' : '前进'}的历史，这一步没有执行。`
        + '这不是页面或站点的问题 —— 是这个标签的历史里确实没有那一步。'
        + '要去别的地址就用 browser_open。');
    }
    return describeNav(nav);
  }

  // 其余六种（click / type / hover / select / scroll / key）全部走同一个入口。
  // `getSnapshot` 只用来解析 `index`：坐标由 dispatch 在派发那一刻重新量。
  return browserService.dispatch(tabId, action, browserService.getSnapshot(tabId));
}
