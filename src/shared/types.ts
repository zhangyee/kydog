import type { AskAnswer, AskQuestion } from './askQuestion';
import type { SerializedError } from './errors';

export type Identity = { userName: string; agentName: string };

export type Project = { path: string; label?: string; addedAt: string; pinned?: boolean };

export type Thread = {
  id: string;
  projectPath: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  pinned?: boolean;
  modelOverride?: { providerId: ProviderId; modelId: string };
};

export type AskBlockBase = {
  kind: 'ask';
  toolCallId: string;
  questions: AskQuestion[];
};

/**
 * 判别联合而不是 status + 可选 answers：让「answered 必有 answers、其余必无」
 * 由编译器保证，下游不必靠注释记忆。
 *
 * cancelled（用户点 ×）/ aborted（signal 被外部中止）/ unanswered（有 toolCall
 * 无 toolResult，进程在挂起时退出）是三个不同的协议事实，不合并。
 */
export type AskBlock =
  | (AskBlockBase & { status: 'answered'; answers: AskAnswer[] })
  | (AskBlockBase & { status: 'pending' | 'cancelled' | 'aborted' | 'unanswered'; answers?: never });

export type AssistantBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'thinking'; text: string; status?: 'running' | 'done';
      durationMs?: number;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      kind: 'tool_call'; id: string; name: string; command?: string;
      chunks: Array<{ stream: 'stdout' | 'stderr'; data: string }>;
      status: 'running' | 'ok' | 'failed'; exitCode?: number;
      startedAt?: number;
      endedAt?: number;
      // 协议级并行标记：同一条 pi assistant message 里 ≥2 个 toolCall 共享同一个 id；
      // 不同 message 的 toolCall 永不共享，即使时间上紧挨着。
      parallelGroupId?: string;
    }
  | AskBlock;

export type Message =
  | { id: string; role: 'user'; createdAt: string; content: string }
  | { id: string; role: 'assistant'; createdAt: string; blocks: AssistantBlock[] };

export type FsNode = { name: string; path: string; kind: 'file' | 'dir' };

export type ThemeName = 'vellum' | 'porcelain' | 'sepia' | 'midnight' | 'lilac';

export type ExternalBinEntry = { name: string; path: string; addedAt: string };

export const THEME_NAMES = ['vellum', 'porcelain', 'sepia', 'midnight', 'lilac'] as const satisfies readonly ThemeName[];
export const READING_FONT_SIZES = ['small', 'medium', 'large'] as const satisfies readonly ReadingFontSize[];

// ── LLM schema v2 ──
export type ProviderId = string;

export type AuthBlob = Record<ProviderId,
  | { type: 'api_key'; key?: string; env?: Record<string, string> }
  | { type: 'oauth'; refresh: string; access: string; expires: number; [k: string]: unknown }
>;

export type AzureCfg = {
  kind: 'azure';
  resourceName?: string;
  apiVersion?: string;
  deploymentNameMap?: Record<string, string>;
};
export type BedrockCfg = {
  kind: 'bedrock';
  authMode: 'profile' | 'iamKeys' | 'bearer';
  awsProfile?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsBearerToken?: string;
  region?: string;
  forceCache?: boolean;
};
export type VertexCfg = {
  kind: 'vertex';
  project: string;
  location: string;
  serviceAccountKeyPath?: string;
};

export type ProviderOverride = {
  baseUrl?: string;
  headers?: Record<string, string>;
  cloud?: AzureCfg | BedrockCfg | VertexCfg;
  defaultModel?: string;
};

export type CompatFlags = Record<string, unknown>;
export type ProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';

export type CustomModel = {
  id: string;
  name?: string;
  api?: ProviderApi;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  compat?: CompatFlags;
};

export type CustomProvider = {
  id: string;
  displayName: string;
  baseUrl: string;
  api: ProviderApi;
  apiKey: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models: CustomModel[];
  defaultModel?: string;
  compat?: CompatFlags;
};

export type ReadingFontSize = 'small' | 'medium' | 'large';

export type ResearchVarKind = 'key' | 'email';
export type ResearchCustomVar = { name: string; kind: ResearchVarKind; value: string };

export type TelemetryState = 'undecided' | 'enabled' | 'deleting' | 'disabled';

export type TelemetryStatus = {
  state: TelemetryState;
  /** 完整 install ID；未参与统计时为 null。设置页显示前 8 位并支持完整复制。 */
  installId: string | null;
  /** 能不能发 beacon：闸门 + 版本与平台自检。false 时开关的**开启**方向没有意义。 */
  canBeacon: boolean;
  /** 能不能出网（开发态 / e2e 为 false）。删除只需要它 —— 半开态（打包版但版本或
   *  平台自检没过）下 canBeacon 为 false 而这个仍为 true，用户照样删得掉、关得掉。
   *  两个布尔必须分开送到 UI：合成一个的话，半开态下 state 为 enabled 的用户
   *  会被禁用的开关锁死，连撤回同意都做不到。 */
  canReachNetwork: boolean;
};

export type SettingsFile = {
  schemaVersion: 8;
  ui: {
    theme: ThemeName;
    locale: 'zh' | 'en';
    workspaceCollapsed: boolean;
    inspectorCollapsed: boolean;
    readingFontSize: ReadingFontSize;
    /** 被用户显式收起的 project 路径。记「收起」而不是「展开」：默认展开，
     *  新加入的 project 无需任何人替它写一条记录就是展开的，而「从没见过」
     *  与「用户收起过」两件事也不会挤在同一个集合里彼此冒充。 */
    collapsedProjects: string[];
  };
  llm: {
    auth: AuthBlob;
    providers: Record<ProviderId, ProviderOverride>;
    customProviders: CustomProvider[];
    defaultProvider: ProviderId | null;
    defaultModel: string | null;
  };
  skills: { disabledBuiltins: string[] };
  tools: { externalBins: ExternalBinEntry[] };
  research: {
    /** 变量名 → 值；键只可能来自 PRESET_RESEARCH_VAR_NAMES。空值不入表。 */
    presets: Record<string, string>;
    custom: ResearchCustomVar[];
  };
  /** 只能由更新服务改（见 update/updateService.ts），故不在 SettingsPatch 中。 */
  updates: {
    autoCheck: boolean;
    /** 已忽略横幅的不透明发布标识；仅做相等比较，不解析。 */
    dismissedCandidateId: string | null;
  };
  /** 四态而非布尔：「已请求删除但尚未收到耐久确认」必须是可落盘的状态，
   *  否则进程在删本地 ID 与写盘之间崩溃时，重启会生成新 ID 重新上报。
   *  只能由 telemetryService 改（见 telemetry/telemetryService.ts），故不在 SettingsPatch 中。 */
  telemetry: { state: TelemetryState; decidedAt: string | null };
  onboarding: { completedAt: string | null };
};

/** settings.update 专用 patch：排除 schemaVersion、onboarding、updates 与 telemetry（spec §7）。
 *  这是**服务层** `settingsService.update` 的入参，含 `ui.locale` —— `locale.set` 的
 *  commitLocale 正是靠它提交语言。RPC 那一侧要窄一档，见 SettingsUpdateArgs。 */
export type SettingsPatch = {
  ui?: Partial<SettingsFile['ui']>;
  llm?: Partial<SettingsFile['llm']>;
  skills?: Partial<SettingsFile['skills']>;
  tools?: Partial<SettingsFile['tools']>;
  research?: Partial<SettingsFile['research']>;
};

/**
 * `settings.update` **RPC** 的参数：在 SettingsPatch 基础上再抠掉 `ui.locale`。
 *
 * 语言切换必须是一个 RPC（换树 + 提交是同一件事，见 protocol.ts 的 `locale.set`）。
 * 允许单独 `settings.update({ ui: { locale } })` 就等于开了一条绕过换树的路，
 * 留下「settings 说 en、磁盘还是中文」的长期不一致 —— 而且它不会报错，只在运行时静默生效。
 * 目前零调用方，这道闸是防将来有人顺手加一个。
 */
export type SettingsUpdateArgs = Omit<SettingsPatch, 'ui'> & {
  ui?: Partial<Omit<SettingsFile['ui'], 'locale'>>;
};

// ── Onboarding RPC ──
export type OnboardingRecovery = 'none' | 'pending' | 'corrupt-discarded';
export type OnboardingCompleteArgs = {
  locale: 'zh' | 'en';
  theme: ThemeName;
  readingFontSize: ReadingFontSize;
  userName: string;
  agentName: string;
  /** onboarding 最后一页的勾选结果。 */
  telemetryEnabled: boolean;
};
export type OnboardingErrorCode = 'invalid-input' | 'model-missing' | 'seed-failed' | 'recovery-pending' | 'manifest-corrupt' | 'already-completed';
export type OnboardingResult = { ok: true } | { ok: false; code: OnboardingErrorCode; message: string };

export type IndexFile = {
  schemaVersion: 1;
  projects: Project[];
  threads: Thread[];
};

/**
 * 中央区「正在看什么」。渲染进程重载后照它接回原处。
 *
 * 只记路径与选择，不记内容：FileTab.id 就是文件绝对路径，其余字段（kind / title /
 * 磁盘内容）uiStore.openFile() 都能重建，记下来只会变成第二份会过期的真相。
 *
 * activeTab 故意不含 'settings'：设置页什么时候顶到前面由 bootstrap 自己判断
 * （首启没配 provider 就强制打开），恢复逻辑不该跟它抢。
 */
export type CenterViewState = {
  threadId: string | null;
  /** 按 tab 顺序排列的文件绝对路径。 */
  filePaths: string[];
  activeFilePath: string | null;
  activeTab: 'thread' | 'file';
};

export type BootstrapState = {
  projects: Project[];
  threads: Thread[];
  settings: SettingsFile;
  appVersion: string;
  systemLocale: 'zh' | 'en';
  identity: Identity;
  onboardingRecovery: OnboardingRecovery;
  /** 上一次渲染进程留下的中央区快照；null = 本次是冷启动（或还没人存过）。 */
  viewState: CenterViewState | null;
};

// ── Skills ──
/** 一次 sync 是在什么时机跑的。失败时原样带回渲染层，用来说清「哪一步没成」。 */
export type SyncPhase = 'startup' | 'onboarding' | 'locale-switch';
/**
 * 内置 skill 同步的健康度。没有「待用户裁决」这一档 —— 内置 skill 按 locale 投影整棵重写，
 * 不再识别用户改动，也就不存在冲突。
 */
export type SkillSyncHealth =
  | { state: 'ok'; installedOrUpgraded: string[]; userSkills: string[] }
  | { state: 'skipped'; reason: 'onboarding-pending' }
  | { state: 'failed'; phase: SyncPhase; skill?: string; message: string };
/** 不导出：只有本文件的 LocaleSetOutcome 用得上。要在别处表达「同步成功」请直接用
 *  SkillSyncHealth 判别 state，别为了少写一次 Extract 把它放出去。 */
type SkillSyncOk = Extract<SkillSyncHealth, { state: 'ok' }>;
export type SkillSyncFailed = Extract<SkillSyncHealth, { state: 'failed' }>;
/**
 * `locale.set` 的结果分档。
 *
 * **「被拒绝」刻意不是一个 `SkillSyncHealth`**：拒绝发生在碰 skill 树之前，树与 settings
 * 都原封不动。把它编码成 `failed` 会让渲染层写进 health store，Settings 从此持久显示
 * 「skill 同步失败」，而主进程记的健康度仍是 ok —— 同一个问题两个相反答案，且 run 结束后
 * 那条横幅也不会自己消失。同理「已经是这个语言」也不产生 health：那一轮根本没跑同步。
 */
export type LocaleSetOutcome =
  /** 目标语言就是当前语言，什么都没做。 */
  | { kind: 'unchanged' }
  /** 换树成功并已提交 settings。sync 是这一轮的健康度，可以直接进 health store。 */
  | { kind: 'applied'; sync: SkillSyncOk }
  /** 业务拒绝（如有任务在跑）。message 是给用户看的中文，skill 树没被碰过。 */
  | { kind: 'rejected'; message: string }
  /**
   * 换树或提交失败，已按旧语言重投影。settings / skills 带回的是旧语言。
   *
   * 两个字段**说的是两件事，不能合并**：
   * - `sync` 是「这次切换为什么没成」的诊断，给内联提示用，是过去时；
   * - `health` 是重投影**之后** skill 树此刻的健康度，给 health store 用，是现在时。
   *
   * 重投影成功时 `health` 就是 ok —— 磁盘上是完好的旧语言树，主进程 `getHealth()`
   * 答的也是这个（`cached` 已被重投影覆盖）。只带 `sync` 回去会让渲染层写一条
   * 「skill 同步失败」进 health store，与主进程对同一个问题给出相反答案，
   * 而且那条横幅刷新一下就消失 —— 正是 `rejected` 当初被从 SkillSyncHealth 里拆出来的同一个毛病。
   */
  | { kind: 'failed'; sync: SkillSyncFailed; health: SkillSyncHealth };
export type SkillEntry = {
  name: string; description: string; origin: 'builtin' | 'user';
  enabled: boolean; dirPath: string; kydogVersion?: string;
};
export type ToolEntry = {
  name: string; version: string | null; path: string; origin: 'builtin' | 'external';
};
export type SkillCandidate = {
  name: string; description: string; relPath: string;
  alreadyInstalled: 'builtin' | 'user' | null; nameInvalid?: string;
};
export type SkillPreview = { srcKind: 'folder' | 'url'; srcPath: string; candidates: SkillCandidate[]; };
export type SkillCommitArgs = {
  srcKind: 'folder' | 'url'; srcPath: string; picks: { name: string; relPath: string }[];
};
export type SkillCommitResult = {
  installed: SkillEntry[]; skipped: { name: string; reason: SerializedError }[]; list: SkillEntry[];
};

// ── 自动升级 ──
export type UpdateCheckPhase =
  | { phase: 'never' }
  | { phase: 'checking' }
  /** 仅 Windows：Squirrel 收到 update-available 后会自动下整包，耗时按带宽算分钟起步。
   *  这段时间既不是「检查中」也不是失败，必须自成一态 —— 否则只能靠 deadline 判超时，
   *  而那条超时提示是假的（下载正在正常进行）。终态由迟到的 downloaded / error 给出。 */
  | { phase: 'downloading' }
  | { phase: 'ok' }
  | {
      phase: 'failed';
      message: string;
      /** 能否再试是协议事实，不是文案细节。UI 据此决定是否禁用「立即检查」，
       *  绝不解析 message。'restart-required' 仅出现在「Windows deadline 已到
       *  且尚未收到任何终态事件」这一种情形。 */
      retry: 'allowed' | 'restart-required';
    };

export type UpdateAvailability =
  | { kind: 'none' }
  | { kind: 'available'; candidateId: string; label: string }
  | { kind: 'downloaded'; label: string };

export type UpdateStatus = {
  check: UpdateCheckPhase;
  update: UpdateAvailability;
  /** 忽略策略（macOS 落盘 / Windows 会话级）被这个布尔吸收，渲染进程不感知差异。 */
  bannerDismissed: boolean;
  autoCheck: boolean;
  currentVersion: string;
};
