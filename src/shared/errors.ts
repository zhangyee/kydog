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
  // 当前标签的 origin 不是这条机构记录确认过的那个，拒绝填充凭据。
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
  // 或者撞了单次求值的时限。**处置是「等一下重试 / 重新取一份快照」**，
  // 与 not_dispatchable（「先把页面打开」）正相反 —— 这两件事一度共用一个码，
  // 于是模型收到它只会去重开页面，白白丢掉当前页面状态，而真实原因多半只是
  // 页面正在换文档。码分开之后，`assertDispatchable` 那道闸的用例也才断得准
  // （删掉闸不会再被这一条用同一个码兜住）。
  | 'browser.page_no_result'
  // wait 到时限条件仍未达成。spec §4.2：「超时只表示条件未达成，不表示别的」——
  // 所以它不能与 failed / timeout 那些导航终态共用措辞，也不是 bad_action。
  | 'browser.wait_timeout'
  // 本轮 run 已经试过一次登录且失败，不再填（spec §4.6）。押的是用户的校园账号，
  // 高校 IdP 普遍锁定连续失败若干次的账号，而模型看到失败会本能地重试。
  | 'browser.login_attempted'
  // safeStorage 不可用（钥匙串被拒等）。**不静默退回明文** —— 那会让「我以为它加密了」
  // 和「它其实是明文」在界面上长得一样。
  | 'settings.secure_storage_unavailable'
  | 'unknown';

export class KydogError extends Error {
  readonly code: KydogErrorCode;
  readonly cause?: unknown;
  constructor(code: KydogErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'KydogError';
    this.code = code;
    this.cause = cause;
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
