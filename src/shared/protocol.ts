import type {
  BootstrapState, Project, Thread, Message, FsNode, SettingsFile, SettingsPatch, SkillSyncHealth, LocaleSetOutcome,
  SkillEntry, ToolEntry, SkillPreview, SkillCommitArgs, SkillCommitResult,
  ProviderId, CustomProvider, Identity, OnboardingCompleteArgs, OnboardingResult, UpdateStatus,
  TelemetryStatus,
} from './types';
import type { AskAnswer, AskOutcome, AskQuestion } from './askQuestion';
import type { SerializedError } from './errors';

export type RpcCall =
  | { method: 'app.bootstrap'; args: undefined; result: BootstrapState }
  | { method: 'settings.get'; args: undefined; result: SettingsFile }
  | { method: 'settings.update'; args: SettingsPatch; result: SettingsFile }
  | { method: 'research.get'; args: undefined; result: SettingsFile['research'] }
  | { method: 'research.save'; args: SettingsFile['research']; result: SettingsFile['research'] }
  | { method: 'project.open'; args: undefined; result: Project }
  | { method: 'project.list'; args: undefined; result: Project[] }
  | { method: 'project.close'; args: { projectPath: string }; result: void }
  | { method: 'project.readDir'; args: { path: string }; result: FsNode[] }
  | { method: 'thread.create'; args: { projectPath: string; title?: string }; result: Thread }
  | { method: 'thread.list'; args: { projectPath: string }; result: Thread[] }
  | { method: 'thread.delete'; args: { threadId: string }; result: void }
  | { method: 'thread.rename'; args: { threadId: string; title: string }; result: void }
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
  | { method: 'locale.set'; args: { locale: SettingsFile['ui']['locale'] }; result: { settings: SettingsFile; skills: SkillEntry[]; outcome: LocaleSetOutcome } }
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
  // ── Onboarding ──
  | { method: 'onboarding.complete'; args: OnboardingCompleteArgs; result: OnboardingResult }
  | { method: 'ask.submit'; args: { threadId: string; toolCallId: string; answers: AskAnswer[] }; result: void }
  | { method: 'ask.cancel'; args: { threadId: string; toolCallId: string }; result: void }
  | { method: 'onboarding.resume'; args: undefined; result: OnboardingResult };

export type RpcMethod = RpcCall['method'];
export type RpcArgs<M extends RpcMethod> = Extract<RpcCall, { method: M }>['args'];
export type RpcResult<M extends RpcMethod> = Extract<RpcCall, { method: M }>['result'];

export type RpcResponse<M extends RpcMethod> =
  | { ok: true; data: RpcResult<M> }
  | { ok: false; error: SerializedError };

export type RuntimeEvent =
  | { topic: 'run.started'; payload: { threadId: string; runId: string } }
  | { topic: 'run.message_delta'; payload: { threadId: string; runId: string; messageId: string; delta: string } }
  | { topic: 'run.thinking_delta'; payload: { threadId: string; runId: string; messageId: string; delta: string } }
  | { topic: 'run.tool_call_start'; payload: { threadId: string; runId: string; toolCallId: string; name: string; command?: string } }
  | { topic: 'run.tool_call_chunk'; payload: { threadId: string; runId: string; toolCallId: string; stream: 'stdout' | 'stderr'; chunk: string } }
  | { topic: 'run.tool_call_end'; payload: { threadId: string; runId: string; toolCallId: string; status: 'ok' | 'failed'; exitCode?: number } }
  | { topic: 'run.parallel_group'; payload: { threadId: string; runId: string; messageId: string; toolCallIds: string[]; parallelGroupId: string } }
  | { topic: 'run.message_end'; payload: { threadId: string; runId: string; messageId: string } }
  | { topic: 'run.ask_start'; payload: { threadId: string; runId: string; messageId: string; toolCallId: string; questions: AskQuestion[] } }
  | { topic: 'run.ask_end'; payload: { threadId: string; runId: string; messageId: string; toolCallId: string; outcome: AskOutcome } }
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
  | { topic: 'update.status'; payload: UpdateStatus }
  // 主进程会在渲染层没发起任何调用的时候改遥测状态：启动时那次「重试未完成的删除」
  // 是 fire-and-forget，窗口开出来时它可能还在飞。没有这条广播，隐私面板就只能
  // 停在它进来那一刻的快照上 —— 删除其实已经完成了，界面却还说「尚未完成」。
  | { topic: 'telemetry.status'; payload: TelemetryStatus };

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
