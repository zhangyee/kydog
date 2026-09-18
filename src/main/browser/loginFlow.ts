import LOGIN_FILL_SOURCE from './injected/loginFill.js?raw';
import { checkLoginHost, isSamlAssertionPost, type LoginHostDecision } from './login';
import { browserWebRequestHub, type WebRequestHub } from './webRequestHub';
import { browserService } from './browserService';
import { resolveTarget, type TargetSpec } from './actions';
import type { AxSnapshot } from './snapshot';
import { institutionService } from '../institution/institutionService';
import { settingsService } from '../settings/settingsService';
import { KydogError } from '../../shared/errors';
import type { InstitutionRecord, SettingsFile } from '../../shared/types';

/**
 * CARSI 机构登录的**执行层**：判据在 `login.ts`（纯函数），凭据的解密在
 * `institutionService`，真正把账号密码写进网页的只有这里。
 *
 * ── 这一层守的三件事 ──────────────────────────────────────────────────────
 *
 * 1. **密码不出这个文件**。它从 `institutionService.reveal()` 进来，拼进一次隔离
 *    世界求值的代码串，然后就没了 —— 不进返回值、不进日志、不进事件、不进错误
 *    消息。上一批评审专门验过「没有第五条出口」，别在这里开一条。
 * 2. **TOCTOU**。`checkLoginHost` 的返回值不能跨越挂起使用（它的 JSDoc 写明了）。
 *    确认框是一次跨进程悬挂，人在框上停留几十秒是常态，页面可以自己跳走。所以
 *    填充前**必须拿当时的 URL 再判一次**，见 `fillInQueue` 里那一行。
 * 3. **同一轮 run 内失败一次就停手**（spec §4.6）。高校 IdP 普遍锁定连续失败的
 *    账号，而模型看到失败会本能地重试。
 */

// ── 每标签的登录状态（spec §4.6 的「失败一次就停手」就压在它上面）───────────

/**
 * 一次填充在这个标签上留下的东西。
 *
 * **状态字段 + 多个读者 = 这个仓库反复栽的地方**，所以写入点与清除点一次列全：
 *
 * | | 在哪 |
 * | --- | --- |
 * | 写 W1 | `attachObserver()` 里唯一那处 `this.tabs.set` —— 由 `fillInQueue` 在注入
 * **之前**调。 |
 * | 写 W2 | 观测者看见断言回传 → `assertionSeen = true` 并 `off()` 自己（拆点一）。 |
 * | 写/清 W3 = C0 | `attachObserver()` 开头的顶替 `this.tabs.get(id)?.off()`（裁决 1 的
 * 第三个拆点）：摘掉旧订阅，随后被 W1 的 `.set` 覆盖 —— **不 delete**，所以它不是
 * 一次真的清除，那条记录的「本轮填过」立刻由新的一条接上。 |
 * | 清 C1 | 标签销毁 → `forget()`（拆点二，走 `browserService.onTabDestroyed`）。 |
 * | 清 C2 | 页面回报「一个字都没写」（`wrote !== true`）→ `forget()`。这一条不是
 * 拆点，是**回滚**：什么都没发生的一次调用不该占掉本轮唯一的那次机会。 |
 * | 清 C3 | `fillInQueue` 的 catch 里 → `forget()`，**只对 `browser.no_tab` /
 * `browser.not_dispatchable`**：`evalInPage` 这两道闸在真正调
 * `executeJavaScriptInIsolatedWorld` **之前**抛，说得出「一个字节都没注进去」。
 * 其余错误（撞时限那条 `page_no_result` 只说得出「结果未知」）一律留着记录。 |
 * | 清 C4 | `_resetForTest()`（只有用例走这条）。 |
 *
 * 编号与 `task-7-report.md` §5 那张表一一对应（早先代码这张表漏了 C3，而报告里有，
 * 于是同一个标号在两处指不同的东西 —— 下一批照代码接线会以为「注入之前抛错不回滚」）。
 *
 * 读者只有两个：`assertNoPriorAttempt()`（判「停手」）与 `noteFor()`（工具结果
 * 头部那句话）。**两个读的是同一张表**，不许有第二份 —— 但注意两个读法不同：
 * `noteFor` 问的是「**这个标签**现在什么状态」，`assertNoPriorAttempt` 问的是
 * 「**本轮名下**有没有填过」，后者按 runId 聚合、跨标签（见它自己那段）。
 */
type TabLogin = {
  /** 这次填充属于哪一轮 run。「停手」只在同一轮内成立。 */
  runId: string | null;
  /** 填的是哪个机构 —— 断言回传的判据要用它的 host。 */
  entityID: string;
  /** 标签归属靠它比对 `details.webContentsId`。**拿不到就不计，别猜**（裁决 1）。 */
  webContentsId: number;
  /** 看见断言回传了吗。这是**唯一**的成功判据 —— 不看状态码、不看页面文案。 */
  assertionSeen: boolean;
  /** 退订 webRequest。幂等（hub 那一侧自带 `done` 闸）。 */
  off: () => void;
};

// ── 端口 ────────────────────────────────────────────────────────────────────

/**
 * 这一层用得到的 browserService 切片。
 *
 * 单独声明而不是直接吃整个 `BrowserService`：本模块要能在没有 electron 的单测里
 * 跑起来，而 `browserService` 那条 import 链一路拖到 `WebContentsView`。
 */
export type LoginBrowserPort = {
  /** 这个标签此刻**已提交**的 URL。`null` = 没有这个标签（或它的渲染进程没了）。 */
  currentUrlOf(tabId: string): string | null;
  webContentsIdOf(tabId: string): number | null;
  getSnapshot(tabId: string): AxSnapshot | null;
  enqueue<T>(tabId: string, fn: () => Promise<T>): Promise<T>;
  /** 第二个参数是**对话 id**（标签归属跟对话走），不是 runId —— 两个同为 `string | null`，传错不报错。 */
  withAgentDriving<T>(tabId: string, threadId: string | null, fn: () => Promise<T>, action?: string): Promise<T>;
  evalInPage(tabId: string, code: string | ((notAfter: number) => string)): Promise<unknown>;
  onTabDestroyed(fn: (tabId: string) => void): () => void;
  /** 见 `fillInQueue` 里那句调用的注释。`origin` 是那一刻页面的 origin —— 与页面
   *  自检用的 `expectOrigin` 是同一个，恢复采集的判据要按它比，不是「填过就不恢复」。 */
  suppressCaptureForCredentials(tabId: string, origin: string): void;
};

export type LoginSettingsPort = {
  get(): Promise<SettingsFile>;
  confirmLogin(entityID: string, origin: string): Promise<boolean>;
};

export type LoginInstitutionPort = {
  reveal(): Promise<{ password: string }>;
};

export type LoginFlowPorts = {
  browser: LoginBrowserPort;
  settings: LoginSettingsPort;
  institution: LoginInstitutionPort;
  /**
   * **惰性取 hub**：`session.fromPartition` 要在 app ready 之后才能调，而本模块在
   * 主进程装配期就被 import。取到的必须是那个**进程级单例** ——
   * `session.webRequest` 每种事件每个 session 只能挂一个监听器，自建第二个
   * 会静默顶掉别人（`webRequestHub.ts` 顶部那段）。
   */
  hub: () => WebRequestHub;
};

/**
 * 首次确认那道是非题。**由调用方（browserTools）用现成的 ask broker 实现** ——
 * 这一层不新发明挂起机制，也不该知道 threadId / toolCallId 长什么样。
 *
 * 返回 `true` 才继续。**必须在标签队列之外调**：占着队列几十秒会把这个标签上的
 * 一切都堵住（裁决 4）。
 */
export type LoginAsk = (args: {
  host: string;
  /**
   * 给用户看的账号。**我们这一侧不往外送** —— 不进工具结果，填进页面之后那个框的
   * value 也被抹掉（见 `injected/loginFill.js` 的 `world.filled` 登记与
   * `snapshot.ts` 的 `filledCredential`）。页面自己回显出来的另说，那关不住。
   */
  username: string;
  institutionName: string;
}) => Promise<boolean>;

export type LoginFillOptions = {
  /** 「本轮已经填过一次」按它聚合。 */
  runId: string | null;
  /** 哪个对话在驱动这个标签 —— 登录期间弹出来的标签归它。**不要拿 runId 顶替**。 */
  threadId: string | null;
  /** 填完直接提交表单吗。**不给就是不提交** —— 见 browserTools 里那段说明。 */
  submit: boolean;
  /** 模型指定的账号框编号（来自某一份快照）。 */
  usernameIndex?: number;
  /** 产生 `usernameIndex` 的快照 id。给了编号就必须给它。 */
  snapshotId?: string;
  ask: LoginAsk;
};

/** 一次成功填充的回执。**没有任何一个字段装得下账号或密码。** */
export type LoginFillOutcome = {
  entityID: string;
  institutionName: string;
  /** 真正填进去的那个页面的 host。 */
  host: string;
  /** 实际选中的账号框（tag + id/name/placeholder，**不含它的值**）。 */
  field: string;
  /** 这个账号框是模型指的还是结构规则找的。 */
  source: 'model' | 'structure';
  submitted: boolean;
  submitHow: 'requestSubmit' | 'click' | null;
  /** 这一次问过用户没有（问过就说明这个 origin 是刚被确认下来的）。 */
  askedUser: boolean;
};

/** 页面回传的形状。改了 `injected/loginFill.js` 的返回结构要同步这里。 */
type LoginFillReply = {
  ok?: unknown;
  /** **页面到底有没有往框里写过东西。** 「停手」那张表的回滚判据就是它。 */
  wrote?: unknown;
  reason?: unknown;
  field?: unknown;
  source?: unknown;
  submitted?: unknown;
  submitHow?: unknown;
  count?: unknown;
  origin?: unknown;
  tag?: unknown;
  type?: unknown;
};

// ── 判据 → 错误码 ───────────────────────────────────────────────────────────

/**
 * `LoginHostDecision.why` → `KydogErrorCode`。**分组判据是「用户/模型下一步该做
 * 什么」**，与 Task 5 的 `institution.idp_list_*` 那一对同一条规矩（按重试有没有用拆）。
 *
 * 五种「当前页面不合格」的下一步完全一样：**别在这一页登录，先导到机构的登录页**。
 * 所以共用 `browser.idp_host_mismatch`，具体原因进 message（`reason` 本来就是给
 * 人看的中文，且刻意不含原始 URL —— 它可能整条带着凭据）。
 *
 * `entity-has-no-host` 是另一件事：这条机构记录（entityID 是 URN 或畸形）
 * **永远**自动登不了，换一页、重试一百次都一样，只能改人工登录或换一条机构记录。
 * 它落 `settings.invalid`。合并进上面那条的代价很具体：模型会一页一页试下去。
 *
 * 写成穷尽 switch：`why` 的联合变长时这里 TS2366 红出来逼人表态，而
 * `default: idp_host_mismatch` 会把新成员静默收进「换一页再试」。
 */
export function loginRefusalError(d: Extract<LoginHostDecision, { kind: 'refuse' }>): KydogError {
  switch (d.why) {
    case 'entity-has-no-host':
      return new KydogError('settings.invalid',
        `${d.reason}。这条机构记录自动登录不了 —— 换一页再试也一样，`
        + '请把这一步交给用户手动登录，或者到设置里换一条有 https 形态 entityID 的机构记录。');
    case 'unparsable':
    case 'no-host':
    case 'not-https':
    case 'bare-ip':
    case 'local-host':
      return new KydogError('browser.idp_host_mismatch',
        `${d.reason}，所以不在这一页填凭据。先导航到这个机构自己的统一身份认证页再调一次。`);
  }
}

/** 页面回报的失败 → 错误。每一种的下一步都不同，所以绝不收敛成一句话。 */
function fillFailureError(r: LoginFillReply): KydogError {
  const n = (v: unknown): string => String(typeof v === 'number' ? v : '?');
  switch (r.reason) {
    case 'expired':
      // 页面赶在主进程那道定时器之前把 expired 送回来了 —— **这次求值确实什么都没做**。
      // 与撞时限那一条（outcome 'unknown'）不许共用措辞，见 browserService 的 evalOn。
      return new KydogError('browser.page_no_result',
        '这一步到达页面的时候已经过了这次求值的时限，它按约定什么都没做 —— 一个字都没填。'
        + '页面多半正被自己的脚本占着主线程，等一下再调一次。', undefined, 'none');
    case 'origin_changed':
      return new KydogError('browser.idp_host_mismatch',
        `准备填的时候页面已经跳到 ${String(r.origin)} 了 —— 一个字都没填。`
        + '先看一眼页面现在在哪，确认它确实是机构的登录页再调一次。');
    case 'no_password':
      return new KydogError('browser.target_unusable',
        '这一页上没有密码框（判据是「此刻 type 就是 password」或者「这个文档里曾经是」），'
        + '一个字都没填。多半还没走到输密码那一屏 —— 先把页面推进到登录表单再调一次。');
    case 'many_passwords':
      return new KydogError('browser.target_unusable',
        `这一页上有 ${n(r.count)} 个密码框，分不出该往哪个填，一个字都没填。`
        + '（这里不猜 —— 猜错就是把校园密码写进一个说不清用途的框。）'
        + '如果这是「修改密码」一类的页面，那它本来就不是登录页；换到登录页再调。');
    case 'stale_username_index':
      return new KydogError('browser.stale_index',
        'usernameIndex 指的那个编号在当前文档里找不到了 —— 页面换过，或者那个编号指的不是 input。'
        + '重新取一份快照，用新快照里的编号再调（一个字都没填）。');
    case 'username_not_same_form':
      return new KydogError('browser.target_unusable',
        'usernameIndex 指的那个框与密码框不在同一个 <form> 里，拒绝填（一个字都没填）。'
        + '账号与密码分属两个表单时，这一页多半是多步登录 —— 先把账号那一步走完。');
    case 'username_not_text':
      return new KydogError('browser.target_unusable',
        `usernameIndex 指的是 ${String(r.tag)}${r.type ? ` type=${String(r.type)}` : ''}，`
        + '不是能装账号的文本框（只收 text / email / tel / number 和没写 type 的），一个字都没填。');
    case 'username_disabled':
      return new KydogError('browser.target_unusable',
        'usernameIndex 指的那个账号框是 disabled 的，填进去也提交不了，所以一个字都没填。');
    case 'no_username':
      return new KydogError('browser.target_unusable',
        '按结构规则找不到账号框：同一个 <form> 里、排在密码框**之前**、可见、没禁用的文本框一个都没有，'
        + '一个字都没填。先取一份快照，把账号框的编号用 usernameIndex 指给我。');
    case 'username_needs_index':
      // 整页没有 <form>：那时「同一个 form」这条判据两边都是 null，退化成没有约束，
      // 页面顶部的站内搜索框与登录框一样合格。**不猜**，让模型指一个。
      return new KydogError('browser.target_unusable',
        '这一页的密码框不在任何 <form> 里，结构规则没法确定哪个文本框是账号框'
        + '（这种页上站内搜索框与账号框一样合格，猜错就是把学号写进搜索框、'
        + '再提交一次账号为空的登录），所以一个字都没填。'
        + '先取一份快照，把账号框的编号用 usernameIndex 指给我。');
    case 'no_form':
      return new KydogError('browser.target_unusable',
        '密码框不在任何 <form> 里，没法提交表单，所以一个字都没填。'
        + '要么这一页靠脚本提交（那就用 submit: false 只填、再自己点按钮），要么它不是登录表单。');
    case 'no_submit':
      return new KydogError('browser.target_unusable',
        '这个表单既没有 requestSubmit()，也找不到 button[type=submit] / input[type=submit] —— '
        + '提交不了，所以一个字都没填。用 submit: false 只填，然后自己点页面上那个提交控件。');
    case 'write_rejected':
      return new KydogError('browser.target_unusable',
        '账号已经写进去了，但立刻回读发现值不是我们写的那个 —— 站点把它改回去了（readonly，或者有脚本在盯着）。'
        + '**页面已经被写过，不可回滚**：先取一份快照看现在什么样，别假设它还是原样。');
    case 'submit_failed':
      // **不带页面那句错误文本。** 它是在密码已经写进页面**之后**读到的字符串
      // （`desc()` 那条同一类），带出来就是又开一条「页面 → 模型上下文」的路；
      // 而模型的下一步与那句话无关。
      return new KydogError('browser.page_no_result',
        '账号和密码都填进去了，但请求提交表单那一下页面抛了错。'
        + '**凭据已经在页面上了**，别重填 —— 取一份快照，自己点页面上的提交控件。');
    default:
      return new KydogError('browser.page_no_result',
        `页面回了一个我们不认识的结果（${String(r.reason)}）。`
        + '**这一步做到哪一步我们不知道** —— 先取一份快照看页面现在什么样，别按「它没做」去重试。',
        undefined, 'unknown');
  }
}

// ── 主体 ────────────────────────────────────────────────────────────────────

/** 机构记录里这一层用得上的部分。 */
type Inst = InstitutionRecord;

export class LoginFlow {
  private readonly tabs = new Map<string, TabLogin>();
  /** 标签销毁的订阅。**惰性装一次** —— 没填过任何东西时不必挂。 */
  private destroyHook: (() => void) | null = null;

  constructor(private readonly ports: LoginFlowPorts) {}

  /**
   * 挂观测者。**挂在标签上，不挂在这次工具调用上** —— `submit: false`（验证码）
   * 是常态路径，那时没有任何工具在飞，观测者必须活得比这次调用久。
   *
   * ── 拆点只有三条，全是协议层事实（裁决 1）──────────────────────────────
   *  ① 看见断言回传（本方法内部）；② 标签被销毁（`forget`）；
   *  ③ 同一标签上又发起一次填充（本方法开头的顶替）。
   *
   * **spec 原文写的「标签离开 IdP 注册域」不做**：eTLD+1 那整套判据已经被拍板
   * 删掉（手写表 fail-open，实测能跨机构钓鱼），而退回 host 相等会在
   * `idp.pku.edu.cn → iaaa.pku.edu.cn` 这一跳上误拆 —— 那正是侦察实测到的真实
   * 登录路径，等于把最常见的成功信号扔掉。
   *
   * **一条如实登记的理论假阳**：用户后来自己在同一个标签上又做了一次真的 SAML
   * 登录（去另一个 SP），那次断言回传会被记成我们这一次的成功。后果只是把
   * 「本轮有一次未观测到回传的填充」这条状态清掉 —— 不会导致再填一次密码，且
   * 标签销毁时（对话删除、到上限被挤掉、用户关掉）会走 `forget`。**所以这里的拆点不是
   * 完备的**，别照着写成「看见回传就一定是我们那一次」。
   */
  attachObserver(args: {
    tabId: string; entityID: string; runId: string | null; webContentsId: number;
  }): void {
    // 顶替：先把上一次的观测者摘掉，否则同一个标签上会挂着两个订阅者，
    // 而 hub 的退订按函数身份删 —— 旧的那个再也没人摘得掉。
    this.tabs.get(args.tabId)?.off();
    const rec: TabLogin = {
      runId: args.runId,
      entityID: args.entityID,
      webContentsId: args.webContentsId,
      assertionSeen: false,
      off: () => {},
    };
    this.tabs.set(args.tabId, rec);
    rec.off = this.ports.hub().onBeforeRequest((details) => {
      if (rec.assertionSeen) return;
      // **归属拿不到就不计。** `webContentsId` 是可选字段（`electron.d.ts:21933`），
      // 拿不到时唯一诚实的做法是不认这一条 —— 拿 url 或时间去猜就是 proxy。
      if (typeof details.webContentsId !== 'number') return;
      if (details.webContentsId !== rec.webContentsId) return;
      if (!isSamlAssertionPost(details, rec.entityID)) return;
      rec.assertionSeen = true;
      rec.off();
    });
  }

  /** 清 C1 / C2：标签销毁，或者页面回报「一个字都没写」。**幂等**。 */
  forget(tabId: string): void {
    const rec = this.tabs.get(tabId);
    if (!rec) return;
    rec.off();
    this.tabs.delete(tabId);
  }

  /**
   * 这个标签上的登录状态，给工具结果的头部用。
   *
   * 它必须挂在**每一个**浏览器工具的结果上，不能只挂在 `browser_login` 的返回值里：
   * `submit: false` 那条路上，断言回传发生在模型点完验证码提交之后，那一刻
   * `browser_login` 早就返回了 —— 不带出来的话，模型永远不知道自己登进去没有。
   */
  noteFor(tabId: string): string | null {
    const rec = this.tabs.get(tabId);
    if (!rec) return null;
    return rec.assertionSeen
      ? '已看到 SAML 断言回传 —— 凭据被机构接受了，这个标签已经登录'
      : '已经填过一次凭据，还没看到断言回传（本轮不会再填第二次）';
  }

  /**
   * spec §4.6：**同一轮 run 内登录失败一次就停手。**
   *
   * 判据 = 「**本轮 run 名下**存在一次尚未观测到断言回传的填充」—— 作用域是 run，
   * 不是标签。**表按标签存、查的时候按 runId 聚合**，两件事分开：存按标签才有干净
   * 的清除点（标签销毁），查按 run 才是 spec 要的那道闸。
   *
   * **只查「这个标签」是不够的**（早先就是那样）：`browser_open` 不给 tabId 就新开
   * 一个标签，标签数没有上限，所以模型收到 `browser.login_attempted` 之后开个新标签
   * 再调一次就照填不误 —— 评审实测一轮里对同一个校园账号连试六次，一次都没被拒。
   * 押的是用户本人的统一身份认证账号，而高校 IdP 普遍锁定连续失败的账号。
   *
   * 刻意**不做**按 runId 增长的表：这个仓库的 runId 那一族已经出过五个洞，全是
   * 「状态字段有多个读者、写入点与清除点没对全」。
   *
   * `runId` 为 `null`（不在任何一轮里）时按「同一轮」算，也就是同样只放一次过。
   * 那时我们**分不出轮次**，而分不出的时候押的仍然是同一个校园账号 —— fail-closed。
   */
  private assertNoPriorAttempt(runId: string | null): void {
    for (const rec of this.tabs.values()) {
      if (rec.assertionSeen) continue;
      if (rec.runId !== runId) continue;
      // 措辞里**不提「在这个标签上」**：那等于替模型点出「换个标签就行」。
      throw new KydogError('browser.login_attempted',
        '本轮已经填过一次机构凭据，而我们没有看到断言回传 —— 那一次多半没成。'
        + '**本轮不再填第二次**（换一个标签页也一样）：高校的统一身份认证普遍会锁定'
        + '连续失败的账号，押的是用户自己的校园账号。请把这一步交给用户：'
        + '让他自己在这个内置浏览器里登录，或者到设置里核对一下机构账号与密码。');
    }
  }

  private async requireInstitution(): Promise<Inst> {
    const inst = (await this.ports.settings.get()).institution;
    if (inst === null) {
      throw new KydogError('settings.invalid',
        '还没有配置机构账号 —— 请用户先到设置里选好学校、填上学号与密码，再用这个工具。');
    }
    return inst;
  }

  private requireUrl(tabId: string): string {
    const url = this.ports.browser.currentUrlOf(tabId);
    if (url === null) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);
    return url;
  }

  /**
   * 填一次机构凭据。
   *
   * 顺序是刻意的，每一步都在挡一件具体的事：
   *
   * 1. **先判「停手」** —— 挡住的那一次连问都不该问用户。
   * 2. 域判据 + （必要时）**在标签队列之外**问一次（裁决 4：占着队列几十秒会把
   *    这个标签上的一切都堵住）。
   * 3. 进队列 → `withAgentDriving` → **TOCTOU 重判** → 取密码 → 挂观测者 → 注入。
   */
  async fill(tabId: string, opts: LoginFillOptions): Promise<LoginFillOutcome> {
    this.ensureDestroyHook();
    this.assertNoPriorAttempt(opts.runId);

    const inst = await this.requireInstitution();
    const before = checkLoginHost({
      entityID: inst.entityID,
      currentUrl: this.requireUrl(tabId),
      confirmedLogins: inst.confirmedLogins,
    });
    if (before.kind === 'refuse') throw loginRefusalError(before);

    let askedUser = false;
    if (before.kind === 'confirm-then-fill') {
      // **这一段在队列之外**。返回值 `before` 从这里开始就不能再用了 ——
      // 下面进了队列会拿当时的 URL 重判（`checkLoginHost` 的 JSDoc 写明的那条）。
      const yes = await opts.ask({
        host: before.host, username: inst.username, institutionName: inst.name,
      });
      if (!yes) {
        throw new KydogError('browser.idp_host_mismatch',
          `用户没有确认 ${before.host} 是 ${inst.name} 的登录页，所以没有填任何东西。`
          + '别再对这个地址调一次 —— 先跟用户确认该去哪个网址登录。');
      }
      askedUser = true;
      // 锁内 read-modify-write。记录已改（用户在框上停留的那几十秒里换了学校）
      // 或已删时返回 false 且不写盘 —— 那时这次确认作废，不去猜用户的意思。
      const wrote = await this.ports.settings.confirmLogin(inst.entityID, before.origin);
      if (!wrote) {
        throw new KydogError('settings.invalid',
          '记录这次确认的时候，设置里的机构账号已经变了（或者被删了），这次确认作废，什么都没填。'
          + '先让用户确认设置里的学校与账号，再重来一次。');
      }
    }

    return this.ports.browser.enqueue(tabId, () => this.ports.browser.withAgentDriving(
      tabId, opts.threadId, () => this.fillInQueue(tabId, opts, askedUser), '机构登录',
    ));
  }

  /** 队列里那一段。**真正碰页面的只有这里。** */
  private async fillInQueue(
    tabId: string, opts: LoginFillOptions, askedUser: boolean,
  ): Promise<LoginFillOutcome> {
    // 排队等待期间本轮可能已经填过一次（两次 browser_login 排在同一个标签的队列里，
    // 或者另一个标签上那一次先落地），而队列外那一判是在排队**之前**做的 ——
    // 那时表里还没有记录。**这一判才是权威的那一次。**
    //
    // 守它的用例是「两次 fill 排在同一个标签的队列里 —— 后一次在队列内被拒」
    // （`loginFlow.test.ts`）。评审 R21 变异（整句删掉）在补这条用例之前存活。
    this.assertNoPriorAttempt(opts.runId);

    // 机构记录**锁外重读**：确认框上悬挂的那几十秒里用户可能换了学校 / 改了密码。
    // 拿队列外那份快照去填，就是把新学校的判据配上旧学校的账号。
    const inst = await this.requireInstitution();

    // ── TOCTOU 重判就是下面这一行 ────────────────────────────────────────
    // 拿的是**这一刻**的 URL（`wc.getURL()`，不是账本里那份 —— 账本靠导航事件更新，
    // 慢一拍），配上**刚重读的** confirmedLogins。只有拿到 `fill` 才可以填。
    const url = this.requireUrl(tabId);
    const now = checkLoginHost({
      entityID: inst.entityID, currentUrl: url, confirmedLogins: inst.confirmedLogins,
    });
    if (now.kind === 'refuse') throw loginRefusalError(now);
    if (now.kind !== 'fill') {
      // 悬挂期间页面跳走了（或者用户在这中间把机构改了，旧的确认跟着作废）。
      // 与五种「页面不合格」同一个码：下一步一样 —— 别在这页填，先导到机构登录页。
      throw new KydogError('browser.idp_host_mismatch',
        `准备填的时候，这个标签已经不在确认过的那个地址上了（现在是 ${now.host}），所以什么都没填。`
        + '先看一眼页面现在在哪 —— 如果确实是机构的登录页，再调一次会重新问你一遍。');
    }

    // 页面那道 origin 自检要比的就是它。**从同一个 `url` 算**，两边不许各算各的。
    let expectOrigin: string;
    try { expectOrigin = new URL(url).origin; } catch {
      throw new KydogError('browser.idp_host_mismatch', '当前标签的网址无法解析，不在这一页填凭据。');
    }

    const webContentsId = this.ports.browser.webContentsIdOf(tabId);
    if (webContentsId === null) throw new KydogError('browser.no_tab', `没有这个标签页：${tabId}`);

    // 模型指定的账号框：在**主进程**这一侧把「编号 + snapshotId」解析成号。
    // 走 `resolveTarget` 而不是自己写：编号绑当前快照这条规矩（以及 stale_index
    // 那几条措辞）只该有一份。
    let usernameNodeId: number | undefined;
    if (opts.usernameIndex !== undefined) {
      // `as TargetSpec` 与 browserService.dispatch 那一处同一个写法：缺 snapshotId /
      // index 不是整数这些形状问题由 `resolveTarget` 自己报（措辞只该有一份）。
      const t = resolveTarget(
        { index: opts.usernameIndex, snapshotId: opts.snapshotId } as TargetSpec,
        this.ports.browser.getSnapshot(tabId),
      );
      // 给了 index 的那一支只会回 node —— 这一句是**类型收窄兼 fail-closed**：
      // 真回了别的东西时宁可整条拒，也不许 `nodeId` 变成 undefined 掉进结构规则
      // （那就成了「我以为按你指的填，其实自己挑了一个」）。
      if (t.kind !== 'node') {
        throw new KydogError('browser.bad_action',
          'usernameIndex 没能解析成页面上的一个元素，这一步没有执行。重新取一份快照再调。');
      }
      // 快照那一层已经判过它是不是密码框；这里**再挡一次**（纵深）：
      // 把账号写进密码框会让密码框里装着账号，而密码随后填不进去。
      if (t.isPassword) {
        throw new KydogError('browser.password_field',
          'usernameIndex 指的是一个密码框。账号框和密码框别指反了 —— 密码由主进程自己填，你只需要指账号框。');
      }
      usernameNodeId = t.nodeId;
    }

    // **密码在这里才出现，而且只往下走一步。** 空串是「配了机构与账号、还没设密码」
    // （`institutionService.reveal` 那时不抛、回空串），得自己判 —— 不判的话我们会
    // 往 IdP 上送一次空密码，白白烧掉本轮唯一那次机会。
    const { password } = await this.ports.institution.reveal();
    if (password === '') {
      throw new KydogError('settings.invalid',
        '设置里配了机构与账号，但没有设密码 —— 请用户先到设置里把机构密码填上。');
    }

    // 观测者挂在**注入之前**：`submit: true` 那条路上，表单一提交断言回传随时可能
    // 到，挂在注入之后就有一段听不见的窗口。同一句里也把「本轮已填过」这条状态
    // 立起来 —— 之后无论注入是成是败，都按 fail-closed 处理（见下面那段）。
    this.attachObserver({ tabId, entityID: inst.entityID, runId: opts.runId, webContentsId });

    // **在注入之前**。密码是在 evalInPage 那一刻进页面的，页面脚本可以在我们抹掉
    // 输入框的值之前读走它并 console.error 出来。放在之后就有一段听不见的窗口。
    // 请求记录同一个开关一起压：登录请求的地址本身可能带票据。
    // 采集在主 frame 换到一个不同 origin 的文档时自动恢复（见 browserService 的
    // did-navigate）——传的是 `expectOrigin`，与页面自检用的同一个值，`back` 命中
    // bfcache 落定的仍是这个 origin 时不会恢复。
    this.ports.browser.suppressCaptureForCredentials(tabId, expectOrigin);

    let raw: unknown;
    try {
      raw = await this.ports.browser.evalInPage(tabId, (notAfter) => `(${LOGIN_FILL_SOURCE})(${JSON.stringify({
        notAfter,
        expectOrigin,
        username: inst.username,
        password,
        usernameNodeId,
        submit: opts.submit,
      })})`);
    } catch (err) {
      // **只有这两个码说得出「一个字节都没注进去」**：`evalInPage` 在真正调
      // `executeJavaScriptInIsolatedWorld` 之前先查标签在不在、有没有渲染进程，
      // 这两条闸抛的就是它们。其余（撞时限的 `page_no_result`，outcome 'unknown'）
      // 明说「结果未知」—— 那时必须留着记录，fail-closed。
      if (err instanceof KydogError
        && (err.code === 'browser.no_tab' || err.code === 'browser.not_dispatchable')) {
        this.forget(tabId);
      }
      throw err;
    }

    if (!raw || typeof raw !== 'object') {
      throw new KydogError('browser.page_no_result',
        '页面没有回传填充结果 —— 多半是在注入中途导航走了。**这一步做到哪一步我们不知道**：'
        + '先取一份快照看页面现在什么样，别按「它没做」去重试。', undefined, 'unknown');
    }
    const reply = raw as LoginFillReply;
    if (reply.ok !== true) {
      // 页面自报「一个字都没写」才回滚这条记录。什么都没发生的一次调用不该占掉
      // 本轮唯一那次机会 —— 而只要它说不出这句话，就按「填过了」算。
      if (reply.wrote !== true) this.forget(tabId);
      throw fillFailureError(reply);
    }

    return {
      entityID: inst.entityID,
      institutionName: inst.name,
      host: now.host,
      field: typeof reply.field === 'string' ? reply.field : '(说不出是哪个框)',
      source: reply.source === 'model' ? 'model' : 'structure',
      submitted: reply.submitted === true,
      submitHow: reply.submitHow === 'requestSubmit' || reply.submitHow === 'click' ? reply.submitHow : null,
      askedUser,
    };
  }

  private ensureDestroyHook(): void {
    if (this.destroyHook) return;
    this.destroyHook = this.ports.browser.onTabDestroyed((tabId) => this.forget(tabId));
  }

  /** 用例专用：把这张表连同它挂着的订阅一起清干净。 */
  _resetForTest(): void {
    for (const rec of this.tabs.values()) rec.off();
    this.tabs.clear();
    this.destroyHook?.();
    this.destroyHook = null;
  }
}

/**
 * 主进程用的那一个。四个端口全部包一层闭包，理由与 `institutionService` 末尾
 * 那段一字不差：`hub` 要惰性（`session.fromPartition` 得 app ready 之后才能调），
 * 而其余三个直接把绑定交出去会让任何 import 到这条链的用例都必须去替身它们。
 */
export const loginFlow = new LoginFlow({
  browser: {
    currentUrlOf: (tabId) => browserService.currentUrlOf(tabId),
    webContentsIdOf: (tabId) => browserService.webContentsIdOf(tabId),
    getSnapshot: (tabId) => browserService.getSnapshot(tabId),
    enqueue: (tabId, fn) => browserService.enqueue(tabId, fn),
    withAgentDriving: (tabId, threadId, fn, action) => browserService.withAgentDriving(tabId, threadId, fn, action),
    evalInPage: (tabId, code) => browserService.evalInPage(tabId, code),
    onTabDestroyed: (fn) => browserService.onTabDestroyed(fn),
    suppressCaptureForCredentials: (tabId, origin) => browserService.suppressCaptureForCredentials(tabId, origin),
  },
  settings: {
    get: () => settingsService.get(),
    confirmLogin: (entityID, origin) => settingsService.confirmLogin(entityID, origin),
  },
  institution: { reveal: () => institutionService.reveal() },
  hub: () => browserWebRequestHub(),
});
