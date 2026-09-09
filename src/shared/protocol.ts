import type {
  BootstrapState, Project, Thread, Message, FsNode, SettingsFile, SettingsUpdateArgs, SkillSyncHealth, LocaleSetOutcome,
  SkillEntry, ToolEntry, SkillPreview, SkillCommitArgs, SkillCommitResult,
  ProviderId, CustomProvider, Identity, OnboardingCompleteArgs, OnboardingResult, UpdateStatus,
  CenterViewState,
  TelemetryStatus,
  BrowserState, BrowserTabsSnapshot, NavigationObservation, RectDip, ViewportMode, IdpListPublic, InstitutionPublic, InstitutionSaveArgs,
  SettingsFileForRenderer,
} from './types';
import type { AskAnswer, AskOutcome, AskQuestion } from './askQuestion';
import type { SerializedError } from './errors';
import type { PdfAnnotationsFile } from './pdfSidecar';
import type { TranslatedDoc, PageLine, Term, TranslateGroup } from './zhSidecar';

export type RpcCall =
  | { method: 'app.bootstrap'; args: undefined; result: BootstrapState }
  // 回的是 SettingsFileForRenderer 而不是 SettingsFile：整份 SettingsFile 里有
  // institution.passwordEnc，这条与 app.bootstrap 才是密文真正的出口（institution.get
  // 那条窄接口拦不住它们）。收口在主进程的 toRendererSettings。
  | { method: 'settings.get'; args: undefined; result: SettingsFileForRenderer }
  // args 是 SettingsUpdateArgs 而不是 SettingsPatch：`ui.locale` 被抠掉了，语言只能走
  // 下面的 locale.set。见 types.ts 的 SettingsUpdateArgs。
  | { method: 'settings.update'; args: SettingsUpdateArgs; result: SettingsFileForRenderer }
  | { method: 'research.get'; args: undefined; result: SettingsFile['research'] }
  | { method: 'research.save'; args: SettingsFile['research']; result: SettingsFile['research'] }
  // ── 内置浏览器 ──
  // 给 tabId 就在那个标签里导航（同一个源的连续详情页复用一个标签），不给就新开。
  | { method: 'browser.open'; args: { url: string; tabId?: string }; result: { tabId: string; nav: NavigationObservation } }
  | { method: 'browser.close'; args: { tabId: string }; result: void }
  // 把 agent 开的标签转成用户的（ownerRunId → null），此后不会被回合结束的回收清掉。
  | { method: 'browser.keep'; args: { tabId: string }; result: void }
  | { method: 'browser.activate'; args: { tabId: string }; result: void }
  | { method: 'browser.navControl'; args: { tabId: string; action: 'back' | 'forward' | 'reload' | 'stop' }; result: void }
  // 渲染进程重载后重建镜像的全量起点。只有 browser.tabsChanged 事件是不够的：
  // 重载后若标签没有新变化就再也收不到事件，browserStore 会一直是空的。
  // 恢复顺序是「先订阅、后 getState、按 revision 去旧」。
  | { method: 'browser.getState'; args: undefined; result: BrowserState }
  // 渲染层上报舞台几何。不带 tabId —— 只有活动标签可见，主进程知道是哪个。
  // visible 与 occluded 是两件事：侧栏关闭（visible=false）不是「被浮层盖住」的同义词。
  | { method: 'browser.syncView'; args: { epoch: number; visible: boolean; occluded: boolean; bounds: RectDip }; result: void }
  // 「1:1 / 适配」开关（spec §4.6）。**按标签**，所以不能并进 syncView ——
  // 那条刻意不带 tabId（「只有活动标签可见，主进程知道是哪个」），而这个状态
  // 每个标签各记一份，切标签时的语义会说不清。
  //
  // 只送一个意向过去，**主进程才是真相**：新的模式随 `browser.tabsChanged` 广播
  // 回来（`BrowserTabInfo.viewportMode`），渲染层照着画开关。渲染层自己记一份的话，
  // agent 在 `markDriving` 里把它恢复成 fit 时，开关会停在错的位置上。
  | { method: 'browser.setViewportMode'; args: { tabId: string; mode: ViewportMode }; result: void }
  // ── CARSI 机构账号 ──
  // 密码只会 渲染层 → 主进程 单向流动：get 返回的 InstitutionPublic 里只有 hasPassword，
  // 连密文也不回传。渲染层没有任何用得上它的地方。
  // 这条窄接口**不是**唯一出口：上面四条回整份 settings 的 RPC 同样得收窄，见
  // SettingsFileForRenderer —— 密文以前正是从那里每次启动都过河的。
  | { method: 'institution.get'; args: undefined; result: InstitutionPublic }
  | { method: 'institution.save'; args: InstitutionSaveArgs; result: InstitutionPublic }
  | { method: 'institution.clear'; args: undefined; result: void }
  // 「显示密码」。密文在渲染层解不开（safeStorage 只在主进程可用），所以眼睛图标
  // 必须走一次往返。这与研究密钥那栏的显隐开关在用户眼里没有区别，只是多一次 RPC。
  | { method: 'institution.revealPassword'; args: undefined; result: { password: string } }
  // 机构清单来自 SP 自己的接口（CNKI 是 fsso.cnki.net/idp/list?federation=2）。
  // 每个 SP 一份，不存在全局 CARSI 清单。
  //
  // result **不是**裸 `IdpEntry[]`：抓不到时服务会回落到落盘的旧清单，而一份空数组在
  // 设置页上等于「这个 SP 一个机构都没有」—— 与「我没抓到」长得一样。所以连同
  // 「哪天抓的」「是不是回落的」一起回（见 types.ts 的 IdpListPublic）。
  | { method: 'institution.listIdps'; args: { refresh?: boolean }; result: IdpListPublic }
  | { method: 'project.open'; args: undefined; result: Project }
  | { method: 'project.list'; args: undefined; result: Project[] }
  | { method: 'project.close'; args: { projectPath: string }; result: void }
  | { method: 'project.readDir'; args: { path: string }; result: FsNode[] }
  | { method: 'thread.create'; args: { projectPath: string; title?: string }; result: Thread }
  | { method: 'thread.list'; args: { projectPath: string }; result: Thread[] }
  | { method: 'thread.delete'; args: { threadId: string }; result: void }
  | { method: 'thread.rename'; args: { threadId: string; title: string }; result: void }
  // 除了返回历史，这个调用还有一个副作用：如果该 thread 有 run 在飞，主进程会把本轮
  // 已经广播过的 run.* 事件**原样重放给发起调用的那个窗口**（见 AgentService.loadHistory）。
  // 理由是渲染进程重载后 buffer 全丢，而在途 run 的终态无法从 pi 的 transcript 反推：
  // 并行批次里 pi 要等整批 settle 才追加 toolResult，此前每个工具的 tool_execution_end
  // 早已发过。所以「重载后拿回终态」只能靠重放主进程留下的事件，不能靠重新归一化 transcript。
  //
  // 重放走 EVENT_CHANNEL、与后续实时事件同一条通道且在同一个同步块里发出，因此二者严格有序、
  // 不重不漏 —— 这也是为什么重放不放在本调用的 result 里：那是另一条通道，跟事件流之间没有顺序保证。
  // 对应地，result 里的 messages **不含**这一轮 in-flight turn（它由重放的事件重建）。
  | { method: 'thread.loadHistory'; args: { threadId: string }; result: Message[] }
  | { method: 'thread.send'; args: { threadId: string; content: string }; result: { runId: string } }
  | { method: 'thread.abort'; args: { threadId: string }; result: void }
  | { method: 'project.openInOS'; args: { projectPath: string }; result: void }
  | { method: 'project.update'; args: { projectPath: string; label?: string; pinned?: boolean }; result: Project }
  | { method: 'thread.update'; args: { threadId: string; title?: string; pinned?: boolean; projectPath?: string; modelOverride?: { providerId: string; modelId: string } | null }; result: Thread }
  // 界面语言切换是一个事务，不是「settings.update + 一次 sync」两次调用：两次之间新建的
  // session 会快照到旧 skill 树，而 sync 失败会留下 settings 说英文、磁盘是中文的长期不一致。
  // 所以 args 只给目标语言，settings / skills / sync 三样结果一次带回。
  // outcome 是判别联合而不是一个 SkillSyncHealth：业务拒绝与同步失败必须分开，
  // 前者压根没碰 skill 树，渲染层不该拿它去写同步状态。见 types.ts 的 LocaleSetOutcome。
  | { method: 'locale.set'; args: { locale: SettingsFile['ui']['locale'] }; result: { settings: SettingsFileForRenderer; skills: SkillEntry[]; outcome: LocaleSetOutcome } }
  | { method: 'skill.getSyncHealth'; args: undefined; result: SkillSyncHealth }
  | { method: 'skill.list'; args: undefined; result: SkillEntry[] }
  | { method: 'skill.setEnabled'; args: { name: string; enabled: boolean }; result: SkillEntry[] }
  | { method: 'skill.pickFolder'; args: undefined; result: string | null }
  | { method: 'skill.previewFromFolder'; args: { srcDir: string }; result: SkillPreview }
  | { method: 'skill.previewFromUrl'; args: { url: string }; result: SkillPreview }
  | { method: 'skill.commitFromPreview'; args: SkillCommitArgs; result: SkillCommitResult }
  | { method: 'skill.uninstall'; args: { name: string }; result: SkillEntry[] }
  | { method: 'skill.openInOS'; args: { name: string }; result: void }
  | { method: 'tool.list'; args: { force?: boolean }; result: ToolEntry[] }
  | { method: 'tool.addExternal'; args: undefined; result: ToolEntry[] }
  | { method: 'tool.removeExternal'; args: { path: string }; result: ToolEntry[] }
  // ── LLM ──
  | { method: 'llm.list'; args: undefined; result: LlmListResult }
  | { method: 'llm.configure'; args: { providerId: ProviderId; cfg: LlmConfigureCfg }; result: LlmListResult }
  | { method: 'llm.remove'; args: { providerId: ProviderId }; result: LlmListResult }
  | { method: 'llm.removeCustom'; args: { customId: string }; result: LlmListResult }
  | { method: 'llm.setDefault'; args: { providerId: ProviderId; modelId: string }; result: LlmListResult }
  | { method: 'llm.setThreadOverride'; args: { threadId: string; override: { providerId: ProviderId; modelId: string } | null }; result: LlmListResult }
  | { method: 'llm.testConnection'; args: { providerId: ProviderId }; result: LlmTestConnectionResult }
  | { method: 'llm.login'; args: { providerId: ProviderId }; result: void }
  | { method: 'llm.loginCancel'; args: { providerId: ProviderId }; result: void }
  | { method: 'llm.loginPromptReply'; args: { providerId: ProviderId; value: string }; result: void }
  | { method: 'llm.logout'; args: { providerId: ProviderId }; result: LlmListResult }
  | { method: 'dialog.pickFile'; args: { filters?: Array<{ name: string; extensions: string[] }> }; result: string | null }
  | { method: 'file.readText'; args: { path: string }; result: { content: string } }
  | { method: 'file.readBytes'; args: { path: string }; result: { bytes: Uint8Array<ArrayBuffer> } }
  // 比 file.readBytes 多一道 realpath 边界校验：path 的 realpath 必须落在 baseDir 的
  // realpath 之内，符号链接指向目录树外也会被拒。学习报告内联本地图片用这个，见
  // reportTheme.ts 的 inlineLocalImages 与 fileService.readBytesWithin 的注释。
  | { method: 'file.readBytesWithin'; args: { baseDir: string; path: string }; result: { bytes: Uint8Array<ArrayBuffer> } }
  | { method: 'file.writeText'; args: { path: string; content: string }; result: void }
  // 把 PDF 的一页画成 PNG（主进程借一个不显示的窗口跑 pdfjs，见 src/main/pdf/pdfRaster.ts）。
  // arXiv 源码包里的插图常常是 .pdf，嵌不进 HTML 报告，得先过一道渲染。
  | { method: 'pdf.renderPage'; args: { path: string; page: number; scale?: number }; result: { pngPath: string } }
  // PDF 旁的标注边车（spec: docs/superpowers/specs/2026-09-03-pdf-annotations-design.md）。
  // load 的 null 只代表边车不存在；解析失败或版本不认识抛 pdf.annotations_invalid，
  // 渲染层据此置灰标注工具且永不覆盖它。
  | { method: 'pdf.annotations.load'; args: { pdfPath: string }; result: { doc: PdfAnnotationsFile | null } }
  | { method: 'pdf.annotations.save'; args: { pdfPath: string; doc: PdfAnnotationsFile }; result: void }
  // PDF 旁的译文边车（spec: docs/superpowers/specs/2026-09-03-pdf-dual-pane-translation-design.md）。
  // null 只代表边车不存在。
  | { method: 'pdf.translation.load'; args: { pdfPath: string }; result: { doc: TranslatedDoc | null } }
  // 翻译流水线（spec: docs/superpowers/specs/2026-09-05-pdf-translation-pipeline-design.md）。
  // 主进程这三条**不持有任何 job 状态**：一页进一页出，取消 = 渲染层停排队。
  | { method: 'pdf.translation.resolveModel'; args: { threadId: string | null };
      result: { providerId: ProviderId; modelId: string; runtimeRevision: number } }
  // 两步协议（spec 2026-09-07 §4）：第一步只分组分类，第二步按组逐个翻译。主进程仍无 job 状态。
  | { method: 'pdf.translation.layout';
      args: { page: number; providerId: ProviderId; modelId: string; runtimeRevision: number;
              // lines 里的 inkTop / inkBottom / scripts 主进程不用，只是复用 PageLine 这个形状（它同时
              // 供渲染层的几何校验与记号化用）——buildUserText 拼提示词时不发它们，模型看不到这些字段。
              docTitle?: string; lines: PageLine[] };
      result: { text: string; truncated: boolean } }
  | { method: 'pdf.translation.translate';
      args: { page: number; providerId: ProviderId; modelId: string; runtimeRevision: number;
              // 语言**代码**（= settings.ui.locale），不是语言名：提示词自己把它换成
              // "Chinese" / "English"（translatePrompt.ts 的 LANG_NAME）。收成联合是
              // 为了让那张映射表少一条时 tsc 就红，别静默把代号喂给模型。
              langOut: 'zh' | 'en'; docTitle?: string; glossary?: Term[]; groups: TranslateGroup[] };
      result: { text: string; truncated: boolean } }
  | { method: 'pdf.translation.save'; args: { pdfPath: string; doc: TranslatedDoc }; result: void }
  // 删译文边车：ENOENT 当成功。渲染层删完走 loadTranslation 重探，doc 变 null 自然退出对照。
  | { method: 'pdf.translation.delete'; args: { pdfPath: string }; result: void }
  // ── 自动升级 ──
  | { method: 'update.getStatus'; args: undefined; result: UpdateStatus }
  | { method: 'update.check'; args: undefined; result: UpdateStatus }
  | { method: 'update.setAutoCheck'; args: { enabled: boolean }; result: UpdateStatus }
  | { method: 'update.dismissBanner'; args: undefined; result: UpdateStatus }
  | { method: 'update.openDownload'; args: undefined; result: void }
  | { method: 'update.restartAndInstall'; args: undefined; result: void }
  // ── 匿名使用统计 ──
  // 三个方法都返回完整状态：渲染层每次操作后都看得到当前真实状态 —— 用户点「关闭」
  // 后拿回 state: 'enabled' 就意味着「什么都没发生」，无需再拉一次。
  | { method: 'telemetry.getStatus'; args: undefined; result: TelemetryStatus }
  | { method: 'telemetry.setEnabled'; args: { enabled: boolean }; result: TelemetryStatus }
  | { method: 'telemetry.deleteMyData'; args: undefined; result: TelemetryStatus }
  // 渲染进程重载后要接回原处，靠的就是这条：中央区状态一变就上报，主进程**只存在内存里**，
  // app.bootstrap 再带回去。刻意不落盘 —— 它要活过渲染进程重载（那时主进程没重启），
  // 但不该活过 app 退出，否则就成了「冷启动也恢复上次会话」那种另一回事的产品行为。
  | { method: 'ui.saveViewState'; args: { state: CenterViewState }; result: void }
  // ── 窗口 ──
  // Windows 的 titleBarOverlay 颜色只能由渲染层给：主题色的真源是 theme CSS 的
  // --color-titlebar-* token，而窗口创建时渲染进程还没起来，主进程手里没有它。
  // ThemeApplier 落完 data-theme 后调这条补上；非 win32 主进程侧直接 no-op。
  | { method: 'window.setTitleBarOverlay'; args: { color: string; symbolColor: string }; result: void }
  // ── Onboarding ──
  | { method: 'onboarding.complete'; args: OnboardingCompleteArgs; result: OnboardingResult }
  | { method: 'ask.submit'; args: { threadId: string; toolCallId: string; answers: AskAnswer[] }; result: void }
  | { method: 'ask.cancel'; args: { threadId: string; toolCallId: string }; result: void }
  | { method: 'onboarding.resume'; args: undefined; result: OnboardingResult };

export type RpcMethod = RpcCall['method'];

/**
 * `RpcCall` 的方法名的**运行时**清单。
 *
 * 为什么需要它：`dispatcher.ts` 的 `handlers[method] = …` 是运行时填表 ——
 * 往 `RpcCall` 加一条而**不注册 handler 不会编译报错、不会有用例红**，只在运行时
 * 回一句 `no handler for …`。本分支一次把这条盲区从 0 条放大到 13 条
 * （`browser.*` 八条 + `institution.*` 五条，都是计划内的 Task 6 Step 5 / Step 8 / Task 8），
 * 所以必须先把「有没有人管这一条」变成可检查的事实。
 *
 * 两道闸配套：
 *  · 下面的 `_allRpcMethodsListed` —— 加了 RpcCall 却没往这里加，`tsc` 就红；
 *  · `handlers.test.ts` 的注册穷尽性用例 —— 每一条要么注册了 handler，要么明确
 *    登记在那份「尚未接线」名单里，两头都得对得上。
 */
export const RPC_METHODS = [
  'app.bootstrap',
  'settings.get',
  'settings.update',
  'research.get',
  'research.save',
  'browser.open',
  'browser.close',
  'browser.keep',
  'browser.activate',
  'browser.navControl',
  'browser.getState',
  'browser.syncView',
  'browser.setViewportMode',
  'institution.get',
  'institution.save',
  'institution.clear',
  'institution.revealPassword',
  'institution.listIdps',
  'project.open',
  'project.list',
  'project.close',
  'project.readDir',
  'thread.create',
  'thread.list',
  'thread.delete',
  'thread.rename',
  'thread.loadHistory',
  'thread.send',
  'thread.abort',
  'project.openInOS',
  'project.update',
  'thread.update',
  'locale.set',
  'skill.getSyncHealth',
  'skill.list',
  'skill.setEnabled',
  'skill.pickFolder',
  'skill.previewFromFolder',
  'skill.previewFromUrl',
  'skill.commitFromPreview',
  'skill.uninstall',
  'skill.openInOS',
  'tool.list',
  'tool.addExternal',
  'tool.removeExternal',
  'llm.list',
  'llm.configure',
  'llm.remove',
  'llm.removeCustom',
  'llm.setDefault',
  'llm.setThreadOverride',
  'llm.testConnection',
  'llm.login',
  'llm.loginCancel',
  'llm.loginPromptReply',
  'llm.logout',
  'dialog.pickFile',
  'file.readText',
  'file.readBytes',
  'file.readBytesWithin',
  'file.writeText',
  'pdf.renderPage',
  'pdf.annotations.load',
  'pdf.annotations.save',
  'pdf.translation.load',
  'pdf.translation.resolveModel',
  'pdf.translation.layout',
  'pdf.translation.translate',
  'pdf.translation.save',
  'pdf.translation.delete',
  'update.getStatus',
  'update.check',
  'update.setAutoCheck',
  'update.dismissBanner',
  'update.openDownload',
  'update.restartAndInstall',
  'telemetry.getStatus',
  'telemetry.setEnabled',
  'telemetry.deleteMyData',
  'ui.saveViewState',
  'window.setTitleBarOverlay',
  'onboarding.complete',
  'ask.submit',
  'ask.cancel',
  'onboarding.resume',
] as const satisfies readonly RpcMethod[];

// 漏一条就在这里编译不过（Exclude 剩下的那个不是 never）。
const _allRpcMethodsListed: Exclude<RpcMethod, (typeof RPC_METHODS)[number]> extends never ? true : never = true;
void _allRpcMethodsListed;
export type RpcArgs<M extends RpcMethod> = Extract<RpcCall, { method: M }>['args'];
export type RpcResult<M extends RpcMethod> = Extract<RpcCall, { method: M }>['result'];

export type RpcResponse<M extends RpcMethod> =
  | { ok: true; data: RpcResult<M> }
  | { ok: false; error: SerializedError };

export type RuntimeEvent =
  | { topic: 'run.started'; payload: { threadId: string; runId: string } }
  | { topic: 'run.message_delta'; payload: { threadId: string; runId: string; messageId: string; delta: string } }
  | { topic: 'run.thinking_delta'; payload: { threadId: string; runId: string; messageId: string; delta: string } }
  // 三个 tool_call 事件都带 messageId：主进程发它们的时候 bound.activeMessageId 就在手上，
  // 不带等于把「这个工具属于哪一轮」丢掉，逼渲染层拿「最近的那个 buffer」「已经含这个
  // toolCallId 的 buffer」去猜 —— 而 buffer 集合为空时（渲染进程刚重载）这两个近似都返回
  // 空，事件就被静默丢弃。归属关系是协议事实，在源头带上。
  | { topic: 'run.tool_call_start'; payload: { threadId: string; runId: string; messageId: string; toolCallId: string; name: string; command?: string } }
  | { topic: 'run.tool_call_chunk'; payload: { threadId: string; runId: string; messageId: string; toolCallId: string; stream: 'stdout' | 'stderr'; chunk: string } }
  | { topic: 'run.tool_call_end'; payload: { threadId: string; runId: string; messageId: string; toolCallId: string; status: 'ok' | 'failed'; exitCode?: number } }
  | { topic: 'run.parallel_group'; payload: { threadId: string; runId: string; messageId: string; toolCallIds: string[]; parallelGroupId: string } }
  | { topic: 'run.message_end'; payload: { threadId: string; runId: string; messageId: string } }
  // browserTabId 是 CARSI / 人机验证的交接口：带上它，渲染层就展开浏览器侧栏并切到那个标签。
  // 刻意不靠「ask 发生时正好有 agent 焦点标签」去推断 —— 那是拿时间相关性当事实。
  | { topic: 'run.ask_start'; payload: { threadId: string; runId: string; messageId: string; toolCallId: string; questions: AskQuestion[]; browserTabId?: string } }
  | { topic: 'run.ask_end'; payload: { threadId: string; runId: string; messageId: string; toolCallId: string; outcome: AskOutcome } }
  // 「把你手上关于这一轮的东西全扔了，接下来我重放一遍」。只在 thread.loadHistory 里
  // 发给发起调用的那个窗口，紧跟其后的就是本轮 journal。它不进 journal —— 它是重放的
  // 帧头，不是 run 本身发生过的事。
  | { topic: 'run.resync'; payload: { threadId: string; runId: string } }
  | { topic: 'run.ended'; payload: { threadId: string; runId: string; reason: 'completed' | 'aborted' | 'error'; errorMessage?: string } }
  | { topic: 'oauth.auth'; payload: { providerId: string; url: string; instructions?: string } }
  | { topic: 'oauth.progress'; payload: { providerId: string; message: string } }
  | { topic: 'oauth.prompt'; payload: { providerId: string; prompt: OAuthPromptPayload } }
  // 上一次 oauth.prompt 作废了：pi 的 per-prompt signal 被 abort（例如浏览器回调先返回，
  // 还挂着的粘贴框就没意义了）。渲染进程该把那个输入框收起来，别等整条登录出结果。
  | { topic: 'oauth.promptCancel'; payload: { providerId: string } }
  | { topic: 'oauth.success'; payload: { providerId: string } }
  | { topic: 'oauth.error'; payload: { providerId: string; error: string } }
  | { topic: 'thread.updated'; payload: { thread: Thread } }
  | { topic: 'fs.changed'; payload: { projectPath: string } }
  // fs.changed 是「项目结构变了」（增删文件/目录 → 刷文件树）；file.changed 是
  // 「这个文件的内容变了」，带路径。两者语义不同，不要用前者代替后者 ——
  // 拿项目级事件当文件级信号就是在下游补 proxy，而路径信号在 chokidar 回调里本来就有。
  | { topic: 'file.changed'; payload: { path: string } }
  | { topic: 'identity.changed'; payload: Identity }
  // pi 的模型目录是两段式的：ModelRuntime.create() 先给内置那份静态清单，随后
  // providerRegistry 起一次不 await 的后台 refresh() 去 pi.dev 拉远端目录（那次 await
  // 会卡住启动，见 providerRegistry.ts 的注释）。后台那次落地时渲染层不会自己知道 ——
  // 没有这条广播，新发布的模型要等用户下一次动作触发 llm.list 才冒出来（全新安装第一次
  // 配 provider 时就是这样：下拉里先只有内置的两个，点一下才长出第三个）。
  // 带整份 LlmListResult 而不是让渲染层再 invoke 一次：主进程这边本来就有，省一个往返。
  | { topic: 'llm.listChanged'; payload: LlmListResult }
  | { topic: 'update.status'; payload: UpdateStatus }
  // 主进程会在渲染层没发起任何调用的时候改遥测状态：启动时那次「重试未完成的删除」
  // 是 fire-and-forget，窗口开出来时它可能还在飞。没有这条广播，隐私面板就只能
  // 停在它进来那一刻的快照上 —— 删除其实已经完成了，界面却还说「尚未完成」。
  | { topic: 'telemetry.status'; payload: TelemetryStatus }
  // 带全量清单而不是 opened/updated/closed 三条增量：标签最多十几条，代价可忽略，
  // 换来的是渲染层不必自己维护一致性 —— 与下面 agentFocus 一条事件承担两个用途同理。
  // 载荷刻意不是 BrowserState —— 广播里不带 epoch，理由见 types.ts 的 BrowserTabsSnapshot。
  | { topic: 'browser.tabsChanged'; payload: BrowserTabsSnapshot }
  // agent 是否正在驱动某个标签。渲染层据此显示状态（指示灯 + 侧栏横幅）。
  // 注意**不做交互屏蔽**：webContents.setIgnoreInputEvents 在 Electron 41 上不存在
  // （2026-09-08 spike 实测），原生层也盖不住 DOM 遮罩。
  //
  // **发送点是 `browserService.emitAgentFocus`**，由 `markDriving` 与
  // `withAgentDriving` 的 `finally` 各调一次（Task 8 接上，`PENDING_EMITTER` 已清空）。
  // 它为什么必须自成一条 topic：信号在主进程本来就有（那对 `registry.setAgentActive`），
  // 但 `setAgentActive` 刻意不推 revision、`toState()` 又会把 `isAgentActive` 抹掉，
  // 所以 `browser.tabsChanged` 广播在类型上和运行时都带不出来。
  //
  // **渲染层按集合语义消费**（`browserStore.applyAgentFocus`）：嵌套驱动时同一个标签
  // 会收到两次 `active: true` 只收到一次 `false`，当计数器用会卡住不灭。
  // `tabId: null` 保留给「一次把全部清掉」，今天没有发送方走这一支。
  | { topic: 'browser.agentFocus'; payload: { tabId: string | null; active: boolean; action?: string } };

/** select 的一个候选项。`id` 是要原样回传给 pi 的答案，label/description 是 provider 自己的措辞。 */
export type OAuthPromptOption = { id: string; label: string; description?: string };

/**
 * 登录流程里 pi 抛给用户的一次提问，镜像 pi 的 `AuthPrompt`（去掉 `signal`——那是主进程内部的事）。
 * select 必须整条把 options 带到渲染进程：只传 message 就等于把「有哪些选项」这个信号丢了，
 * 下游只能猜一个默认值。
 */
export type OAuthPromptPayload =
  | { type: 'text'; message: string; placeholder?: string }
  | { type: 'secret'; message: string; placeholder?: string }
  | { type: 'manual_code'; message: string; placeholder?: string }
  | { type: 'select'; message: string; options: readonly OAuthPromptOption[] };

export type EventTopic = RuntimeEvent['topic'];
export type EventPayload<T extends EventTopic> = Extract<RuntimeEvent, { topic: T }>['payload'];

/**
 * **事件 topic 的台账**，与 RPC 那套（`RPC_METHODS` + `handlers.ts` 的 registerHandler +
 * `handlers.test.ts` 的穷尽性闸）一一对应。
 *
 * 为什么要有：往 `RuntimeEvent` 加一条 topic 而**没有任何地方发它**，不会编译报错、
 * 不会有用例红 —— 订阅方照常订阅，指示灯永远不亮。这与「加了 RpcCall 却忘了注册
 * handler」是同一类盲区，本批刚给 RPC 关掉，换个通道不能再开着。
 *
 * 三方对账在 `src/main/ipc/eventLedger.test.ts`：
 *  · **声明**：下面这张表（漏一条在下面那行编译不过）；
 *  · **已接**：扫 `src/main/**` 真实的 emit 调用点（`broadcaster.emit` / `emitRun` /
 *    `{ topic: … }` 三种形态）；
 *  · **待接**：那份用例里的 `PENDING_EMITTER`，每条都要写清楚谁来接。
 */
export const EVENT_TOPICS = [
  'run.started',
  'run.message_delta',
  'run.thinking_delta',
  'run.tool_call_start',
  'run.tool_call_chunk',
  'run.tool_call_end',
  'run.parallel_group',
  'run.message_end',
  'run.ask_start',
  'run.ask_end',
  'run.resync',
  'run.ended',
  'oauth.auth',
  'oauth.progress',
  'oauth.prompt',
  'oauth.promptCancel',
  'oauth.success',
  'oauth.error',
  'thread.updated',
  'fs.changed',
  'file.changed',
  'identity.changed',
  'llm.listChanged',
  'update.status',
  'telemetry.status',
  'browser.tabsChanged',
  'browser.agentFocus',
] as const satisfies readonly EventTopic[];

// 漏一条就在这里编译不过（Exclude 剩下的那个不是 never）。
const _allEventTopicsListed: Exclude<EventTopic, (typeof EVENT_TOPICS)[number]> extends never ? true : never = true;
void _allEventTopicsListed;

/**
 * 一轮 run 期间主进程发出的事件。主进程按发出顺序留一份（journal），渲染进程重载后
 * 原样重放，落回同一批 store 动作 —— 重放路径与直播路径是同一段代码，不存在第二套
 * 「从 transcript 反推 block」的推导逻辑会跟直播路径走偏。
 *
 * run.ended 在类型上属于这里，但永远不会进 journal：它一到就说明这轮不再在飞，
 * 主进程在同一处把 journal 清掉。
 */
export type RunEvent = Extract<RuntimeEvent, { topic: `run.${string}` }>;
export type RunEventTopic = RunEvent['topic'];

/** 渲染层照这张表逐个订阅。下面那行断言保证新加的 run.* topic 不会漏在这里。 */
export const RUN_EVENT_TOPICS = [
  'run.started',
  'run.message_delta',
  'run.thinking_delta',
  'run.tool_call_start',
  'run.tool_call_chunk',
  'run.tool_call_end',
  'run.parallel_group',
  'run.message_end',
  'run.ask_start',
  'run.ask_end',
  'run.resync',
  'run.ended',
] as const satisfies readonly RunEventTopic[];

// 漏一个 topic 就在这里编译不过（Exclude 剩下的那个不是 never）。
const _allRunTopicsListed: Exclude<RunEventTopic, (typeof RUN_EVENT_TOPICS)[number]> extends never ? true : never = true;
void _allRunTopicsListed;

export const RPC_CHANNEL = 'kydog:rpc' as const;
export const EVENT_CHANNEL = 'kydog:event' as const;

export type LlmConfiguredEntry = {
  providerId: ProviderId;
  displayName: string;
  kind: 'oauth' | 'apiKey' | 'cloud' | 'custom';
  authStatus: { configured: boolean; source?: string; label?: string };
  modelIds: string[];
  defaultModel: string | null;
};

export type LlmListResult = {
  catalog: Array<{
    id: ProviderId;
    displayName: string;
    kind: string;
    group: string;
    /** True if this entry supports OAuth login (in addition to whatever its primary kind says). */
    supportsOAuth?: boolean;
  }>;
  configured: LlmConfiguredEntry[];
  customProviders: CustomProvider[];
  defaultProvider: ProviderId | null;
  defaultModel: string | null;
};

export type LlmConfigureCfg =
  | { kind: 'apiKey'; apiKey: string; baseUrl?: string; headers?: Record<string, string> }
  | { kind: 'cloud'; cloud: import('./types').AzureCfg | import('./types').BedrockCfg | import('./types').VertexCfg; apiKey?: string; baseUrl?: string }
  | { kind: 'custom'; provider: CustomProvider };

export type LlmTestConnectionResult = { ok: boolean; message?: string };
