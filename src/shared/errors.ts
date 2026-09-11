export type KydogErrorCode =
  | 'settings.invalid'
  | 'settings.write_failed'
  | 'thread.not_found'
  | 'thread.busy'
  | 'thread.has_messages'
  | 'project.not_found'
  | 'project.access_denied'
  | 'agent.provider_error'
  | 'agent.aborted'
  | 'fs.read_failed'
  | 'fs.write_failed'
  | 'fs.too_large'
  | 'fs.access_denied'
  | 'pdf.annotations_invalid'
  | 'pdf.translation_invalid'
  | 'not_implemented'
  | 'skill.invalid'
  | 'skill.name_conflict'
  | 'skill.network'
  | 'skill.too_large'
  | 'skill.unsupported_archive'
  | 'skill.extract_failed'
  | 'skill.uninstall_forbidden'
  | 'llm.invalid'
  // 「没配模型 / 钉住的模型或运行时已经不在了」。与 llm.invalid 分开，是因为处置不同：
  // 这条要中止整趟翻译，llm.invalid 只让当前那一页记失败。渲染层按码分支，不匹配 message
  // 字符串——码是协议层的，字符串不是。
  | 'llm.not_configured'
  // ── 内置浏览器 ──
  | 'browser.bad_url'
  // 动作批次本身不合法：空列表、repeat 嵌套、times 越界、展开后超步数上限、
  // 不认识的按键名。与 bad_url 分开 —— 那条只管网址。
  | 'browser.bad_action'
  | 'browser.no_tab'
  | 'browser.too_many_tabs'
  // 模型的 type 动作打到了 input[type=password]。判据是元素类型这个协议层事实，
  // 不是「看起来像密码框」。密码一律由主进程填（见 browser.idp_host_mismatch）。
  | 'browser.password_field'
  // 动作引用的快照编号已失效。挡的不只是「编号不存在」—— 更危险的是编号还在、
  // 指向的元素变了：那样不报错，只是点错东西。所以编号绑 snapshotId + backendNodeId。
  | 'browser.stale_index'
  // **不在当前这一页填凭据。** 生产者是 `loginFlow`，六种成因共用它，因为
  // 下一步完全一样：**先导到机构自己的统一身份认证页，再调一次**。
  //  · 当前标签的 origin 不是这条机构记录确认过的那个（含用户拒绝确认那一次）；
  //  · `checkLoginHost` 判「这一页不合格」的五种之四（非 https / 没有主机名 /
  //    裸 IP / 内网名字 / 网址解析不了）；
  //  · 悬挂期间页面跳走，填充前的 TOCTOU 重判没通过；
  //  · 页面自己那道 origin 自检发现文档已经换了。
  // 第五种 `entity-has-no-host` **不在这里**：那条机构记录永远自动登不了，
  // 换一页再试一百次也一样，走 `settings.invalid`（下一步是改人工登录）。
  | 'browser.idp_host_mismatch'
  // elementFromPoint 命中的不是目标，被浮层挡住了（spec §4.2）。与 stale_index 分开：
  // 那条是编号指向的元素变了，这条是编号没错、点不着。
  | 'browser.click_intercepted'
  // ── 下面三条是 spec §9.1 那份清单之外新加的，各自对应模型完全不同的下一步 ──
  // 目标在当前页面上不可操作：选择器没有匹配 / 折叠到看不见 / 滚进视野后仍在视口外 /
  // 不是能打字的控件 / disabled / <select> 里没有这个值。**处置是「换目标」**。
  // 不能拿 bad_action 顶（动作本身没毛病），也不能拿 stale_index 顶
  // （那条说的是「重新取快照」，而选择器无匹配再取一百次快照也一样）。
  | 'browser.target_unusable'
  // 这个标签这一刻发不了输入事件：没有渲染进程（页面从没加载过 / 刚崩过），
  // 或者 CDP 被顶掉了。**处置是「先把页面打开」**，与目标无关。
  // 单列一条是因为不闸住的代价实测有三种、且都不报错：mouse 事件 reject 一句
  // 内容为「Internal error」的话、`Input.insertText` **永不 settle**（整轮 run 挂死）、
  // `Input.dispatchKeyEvent` 照常 resolve（于是回报「按下 Enter」而它一个字都没发出去）。
  | 'browser.not_dispatchable'
  // 往页面里注的那段脚本**没有拿回可用的结果**：求值 reject 了、回来的东西不成形状、
  // 撞了单次求值的时限，或者页面自己报「到达时已经过了时限、什么都没做」。
  // **这四种里只有最后一种说得出「没有发生」** —— 撞时限那一条取消不掉已经注进去的
  // 求值（实测：页面回魂之后照常执行），它只说得出「结果未知」（见 `evalOn` 的实测表）。
  // **处置是「等一下重试 / 重新取一份快照」**，
  // 与 not_dispatchable（「先把页面打开」）正相反 —— 这两件事一度共用一个码，
  // 于是模型收到它只会去重开页面，白白丢掉当前页面状态，而真实原因多半只是
  // 页面正在换文档。码分开之后，`assertDispatchable` 那道闸的用例也才断得准
  // （删掉闸不会再被这一条用同一个码兜住）。
  | 'browser.page_no_result'
  // wait 到时限条件仍未达成。spec §4.2：「超时只表示条件未达成，不表示别的」——
  // 所以它不能与 failed / timeout 那些导航终态共用措辞，也不是 bad_action。
  | 'browser.wait_timeout'
  /**
   * `back` / `forward` 要去的那一步历史不存在。**这不是失败，是一个事实**：
   * `canGoBack()` / `canGoForward()` 说了没有。之所以做成错误而不是一句说明后继续跑，
   * 是因为 browser_act 的语义是「出错即停」—— 后退没成而后面的动作照跑，
   * 等于让模型在一个它以为已经离开的页面上继续操作，且不报任何错。
   */
  | 'browser.no_history'
  // 本轮 run 已经试过一次登录且失败，不再填（spec §4.6）。押的是用户的校园账号，
  // 高校 IdP 普遍锁定连续失败若干次的账号，而模型看到失败会本能地重试。
  // 生产者是 `loginFlow`，判据是「本轮 run 名下、这个标签上存在一次**尚未观测到
  // SAML 断言回传**的填充」——「失败」这件事本身没有别的协议层信号可用
  // （密码错时多数 IdP 回 200 错误页或 302 回自己）。**处置是交给用户**，不是重试。
  | 'browser.login_attempted'
  // 钥匙串这一刻用不了：`isEncryptionAvailable()` 为 false（钥匙串被拒、Linux 上没有
  // 可用的 keyring），或者 `encryptString` 自己抛。**密码没有丢** —— 已经存下的那份
  // 还在，让钥匙串恢复可用就照常取得出来；这一次没存进去的，修好之后再设一次即可。
  // **处置是「修钥匙串」，重试有用。**
  // **保存时不静默退回明文** —— 那会让「我以为它加密了」和「它其实是明文」在界面上
  // 长得一样（spec §4.6）。落点是 institutionService.save / .reveal。
  | 'settings.secure_storage_unavailable'
  // 已经存下的那份密文解不开了（换了机器、钥匙串条目被删）。**密码永久失效，
  // 修钥匙串没有用，只能重新填一次。处置与上一条正相反，所以不共用一个码。**
  //
  // 判据与本文件里 institution.idp_list_* 那一对是同一条：**重试有没有用**。
  // 共用一个码的具体后果：`hasPassword` 在两种情形下都还是 true（`passwordEnc !== ''`），
  // 于是「有一个密码、但它已经取不出来了」这个状态在界面上无法表达 —— 渲染层只能按
  // 码分支（措辞不是判据），用户看到的是「密码已设置」配着一句「钥匙串当前不可用」，
  // 而钥匙串其实是好的。落点是 institutionService.reveal。
  | 'settings.stored_password_unreadable'
  // ── CARSI 机构清单 ──
  // 字节拿到了，但读不成一份清单：不是合法 JSON / 不是数组 / 读到 N 条一条都没留下 /
  // 按响应自己声明的 charset 解不出来 / 超过字节上限。**处置是「这个源现在给不了清单」，
  // 重试一百次也一样。**
  // 从前借 `skill.invalid`（连消息都是「机构清单不是合法 JSON」），渲染层要把它与
  // 技能包解析失败分开时会撞车 —— 两者在界面上要说的话完全不同。
  | 'institution.idp_list_invalid'
  // 压根没拿到字节：网络错、撞 deadline、HTTP 非 2xx。**处置是「重试 / 用落盘的旧清单」**，
  // 与 idp_list_invalid 正相反。两件事共用一个码的话，界面只说得出一句「机构清单出错」，
  // 而其中一件重试有用、另一件重试无用。
  | 'institution.idp_list_unavailable'
  | 'unknown';

export class KydogError extends Error {
  readonly code: KydogErrorCode;
  readonly cause?: unknown;
  /**
   * `browser.page_no_result` 专用的判别值 —— 它有四种成因（见上面那条注释），
   * 但只有「页面自己回 expired」说得出「没有发生」，撞时限那一条只说得出
   * 「结果未知」。两者共用一个错误码、消息又都是给模型看的散文，散文会改写、
   * 会被复述成别的措辞——**判别语义的必须是这个字段，不是消息里有没有某几个词**。
   * 其余错误码不用它，恒为 undefined。
   *
   * **现状如实登记：目前只有生产方在写它，还没有生产读者**（读它的只有用例）。
   * 它也**过不了 IPC** —— `SerializedError` 只带 `code` + `message`，所以渲染层
   * 拿不到它；真去按它分支时 tsc 会当场红（那个属性不在 `SerializedError` 上），
   * 不会静默出错。写在这里是为了让「以后要分这两件事就读这个字段、别去 match 散文」
   * 这条约定有个落点 —— 别把它当成一道已经接上负载的闸。
   */
  readonly outcome?: 'unknown' | 'none';
  constructor(code: KydogErrorCode, message: string, cause?: unknown, outcome?: 'unknown' | 'none') {
    super(message);
    this.name = 'KydogError';
    this.code = code;
    this.cause = cause;
    this.outcome = outcome;
  }
}

export type SerializedError = { code: KydogErrorCode; message: string };

export function serializeError(err: unknown): SerializedError {
  if (err instanceof KydogError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: 'unknown', message: err.message };
  return { code: 'unknown', message: String(err) };
}

export interface RpcError extends Error { readonly code: KydogErrorCode }
export function isRpcError(e: unknown): e is RpcError {
  return e instanceof Error && typeof (e as { code?: unknown }).code === 'string';
}
