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
  /**
   * 这一轮以错误结束（provider 拒了请求、网络断了……），`text` 是错误原文。
   *
   * **它是这一轮回复自己的事实**，不是整条对话的状态：pi 把 `stopReason: 'error'` 与
   * `errorMessage` 记在这一轮的 assistant 消息上。所以它跟文字、工具一样是一个块 ——
   * 一个字都没输出就失败时，这一轮也照样成条；重启后从 transcript 归一化出来的，
   * 与实时看到的是同一样东西。
   */
  | { kind: 'error'; text: string }
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
  schemaVersion: 9;
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
    /** 浏览器侧栏是否打开。它与 inspectorCollapsed 是两件事：两者共用右栏那块地，
     *  但各记各的状态与宽度 —— 关掉浏览器时 Inspector 要回到用户上次留下的样子。 */
    browserOpen: boolean;
    /** 浏览器侧栏宽度。下限 320：页面按固定 1280 逻辑视口渲染，再窄就只能靠更小的
     *  scale 硬压，人眼已经读不了了。
     *
     *  `null` = **用户从没拖过**，由渲染层按当前窗口现算 4:6（见 `rightPane.ts` 的
     *  `browserWidthFor`）。不编一个默认像素数出来：那等于替用户做了一个他没做过的
     *  决定，而一旦落盘就再也分不清「4:6」是算出来的还是他真的拖成了这个数。 */
    browserWidth: number | null;
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
  /**
   * CARSI 机构账号。**只能由 institutionService 经专用方法改，故不在 SettingsPatch 中**
   * —— 与 updates / telemetry / onboarding 同一条约定。这道闸挡的是具体的东西：
   * 允许渲染层用 settings.update 写它，就等于开了一条把**明文密码**直接塞进
   * passwordEnc 字段的路，绕过 safeStorage 且不会报错。
   *
   * null = 没配过。passwordEnc 是 safeStorage 密文的 base64；渲染层解不开它
   * （解密只能在主进程），要看明文得显式走 institution.revealPassword。
   */
  institution: InstitutionRecord | null;
  /** 四态而非布尔：「已请求删除但尚未收到耐久确认」必须是可落盘的状态，
   *  否则进程在删本地 ID 与写盘之间崩溃时，重启会生成新 ID 重新上报。
   *  只能由 telemetryService 改（见 telemetry/telemetryService.ts），故不在 SettingsPatch 中。 */
  telemetry: { state: TelemetryState; decidedAt: string | null };
  onboarding: { completedAt: string | null };
};

/**
 * 渲染层看得到的那份 settings。**它与 SettingsFile 的唯一区别就是没有 `passwordEnc`。**
 *
 * app.bootstrap / settings.get / settings.update / locale.set 四条都回整份 settings。
 * 它们直接回 SettingsFile 的时候，protocol.ts 上那句「密码只会 渲染层 → 主进程 单向流动，
 * 连密文也不回传」是假的：每次启动主进程就把 institution.passwordEnc 交给了 useSettingsStore，
 * 而 institution.revealPassword 那道「显式往返」的设计意图正是不让它自动过去。
 *
 * 靠调用点自觉删字段守不住（四条路、任何一条新增都会漏），所以改成类型说了算：
 * InstitutionRecord 不能赋给 InstitutionPublic（少一个 hasPassword），主进程收口处
 * 必须过一次 toRendererSettings。
 */
export type SettingsFileForRenderer = Omit<SettingsFile, 'institution'> & {
  institution: InstitutionPublic;
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

// ── Harness（spec: docs/superpowers/specs/2026-09-17-harness-template-update-design.md）──
// 渲染层只能点名这三份，不能给路径：主进程拿名字去 ~/.kydog/ 下找。
export const HARNESS_FILE_NAMES = ['SOUL.md', 'USER.md', 'AGENTS.md'] as const;
export type HarnessFileName = (typeof HARNESS_FILE_NAMES)[number];
/** 相对当前界面语言的当前模板而言（spec §3.2）。 */
export type HarnessTemplateState = 'latest' | 'available' | 'kept' | 'missing';
/** 写入之后改没改过：只对 available / kept 有意义，供界面说明「更新会不会丢东西」。 */
export type HarnessEditState = 'unchanged' | 'edited' | 'unknown';
export type HarnessFileStatus = {
  name: HarnessFileName;
  template: HarnessTemplateState;
  edit: HarnessEditState | null;
  /** 当前模板的语言（= 界面语言），「新模板是英文版 / 中文版」那句用。 */
  templateLocale: 'zh' | 'en';
  /** 写入时用的模板与当前界面语言不同。 */
  localeDiffers: boolean;
};
export type HarnessChoice = { name: HarnessFileName; choice: 'update' | 'keep' };
export type HarnessApplyResult = { name: HarnessFileName } & (
  // backupName 只是文件名（在 ~/.kydog/ 下）；创建（原本不存在）时为 null。
  | { outcome: 'updated'; backupName: string | null }
  | { outcome: 'kept' }
  | { outcome: 'failed'; error: string });
export type HarnessReadResult =
  | { exists: false }
  | { exists: true; content: string; frontmatterName: string | null; body: string };
/** diskContent 为 null = 文件已不存在。 */
export type HarnessWriteResult = { ok: true } | { ok: false; diskContent: string | null };

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

/**
 * 设置文件这一次是怎么读出来的。**`ok` 之外都要让用户看得见** ——
 * 「把原件留档」这件事只有用户看得见才算数：只写日志的话，用户看到的是
 * 设置被清空了、外加目录里多出一个陌生文件名，没人会把两件事联系起来。
 *
 * 两档不是同一件事，下一步也不同：
 *  · `quarantined` —— 原件**已经留档**（`backup` 是留档的文件名，只有文件名不带路径），
 *    当前用的是一份全新的默认设置。用户要做的是去那份备份里把 key 抄回来。
 *  · `unreadable` —— 原件**还在原地**，只是这一次没读出来（`why` 是 errno）。
 *    此时**写盘已经被拒**（见 settingsService.withLock），改设置会失败。
 *    用户要做的是解决占用/权限，而不是重填。
 */
export type SettingsHealth =
  | { kind: 'ok' }
  | { kind: 'quarantined'; backup: string }
  | { kind: 'unreadable'; why: string };

export type BootstrapState = {
  projects: Project[];
  threads: Thread[];
  /** 不是 SettingsFile：这份是发给渲染层的，密文不过河。见 SettingsFileForRenderer。 */
  settings: SettingsFileForRenderer;
  appVersion: string;
  systemLocale: 'zh' | 'en';
  identity: Identity;
  onboardingRecovery: OnboardingRecovery;
  /** 上一次渲染进程留下的中央区快照；null = 本次是冷启动（或还没人存过）。 */
  viewState: CenterViewState | null;
  /** 设置文件这一次是怎么读出来的 —— `ok` 之外要在设置页横幅上说出来。 */
  settingsHealth: SettingsHealth;
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


// ─────────────────────────────────────────────────────────────────────────────
// 内置浏览器（slowpaper 一期）
// ─────────────────────────────────────────────────────────────────────────────

/** 一块矩形，单位是 DIP（与 BrowserWindow 的坐标系一致），不是设备像素。 */
export type RectDip = { x: number; y: number; width: number; height: number };

/**
 * 浏览器侧栏的宽度下限与默认值。**放在 shared 是因为两个进程都要用同一个数**：
 * 主进程 `settingsFile.sanitizeBrowserWidth` 落盘前钳一次，渲染层拖拽时也要当场钳
 * （不钳的话拖出去的那一帧会以非法宽度上报 `syncView`，主进程照单全收把网页定位过去，
 * 直到下一次落盘往返才被拉回来）。两边各写一个字面量就是两份会漂的真相。
 *
 * **320 不是一个钳位点。** spec §2.3 原来的依据（Chromium zoom 下限 0.25 × 1280）
 * 在改用 `Emulation.setDeviceMetricsOverride` 之后**已经不成立** —— 技术上可以更窄。
 * 现在它只剩一条经验依据：`scale` 到 0.25 时页面上的字已经读不了。
 * spec 明写这个数「需要重新拍」，**在项目负责人重新拍之前不要自己改**。
 */
export const MIN_BROWSER_WIDTH = 320;
export const DEFAULT_BROWSER_WIDTH = 560;

/**
 * 这个标签按多宽渲染（spec §4.6 的「1:1 / 适配」开关）。
 *
 * - `fit`（默认）——**逻辑视口 1280**，整幅按 `侧栏宽 / 1280` 缩进侧栏。
 *   agent 手上那份快照的坐标就活在这个 1280 的坐标系里。舞台宽过 1280（全屏）时**不放大**：
 *   按舞台宽排版、scale 1 —— 放大时 Chromium 的画布比舞台小，右侧与底部露白、内容被裁。
 * - `oneToOne` ——**排版与 `fit` 完全相同，只把 Chromium 自己的 pinch-zoom（page scale）
 *   放大到 `1280 / 侧栏宽`**，页面 1:1 显示、不重排。侧栏窄于 1280 时只看得到一段，
 *   触控板双指横移 / 纵滚走 Chromium 原生的 visual viewport，鼠标点击也由它映射。
 *   舞台宽过 1280（全屏）时与 `fit` 相同：按舞台宽排版、scale 1。原生 view 一律等于舞台。
 *
 * **它是主进程手上的一个按标签的状态事实**，不是渲染层的一个显示偏好：只要它处在
 * `oneToOne`，page scale 就不是 1，agent 的派发坐标当场对不上。所以它跟着 `BrowserTabInfo`
 * 广播给渲染层（开关要照着主进程的真相画），而**恢复由主进程自己做**
 * —— 见 `browserService.markDriving` 与 `dispatch`。
 */
export type ViewportMode = 'fit' | 'oneToOne';

export type BrowserTabInfo = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  /** 'agent' = 本轮 run 开的，run settle 时会被回收；'user' = 用户的，常驻。 */
  owner: 'agent' | 'user';
  canGoBack: boolean;
  canGoForward: boolean;
  /** 见 `ViewportMode`。**agent 对这个标签的下一次动作之前会被恢复成 `fit`。** */
  viewportMode: ViewportMode;
};

/** 标签栏那三个字段的唯一出处。BrowserState 与 BrowserTabsSnapshot 都从这里派生，
 *  但**两者互不派生** —— 理由见 BrowserTabsSnapshot 末尾那段。 */
type BrowserTabsCore = {
  revision: number;
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
};

/**
 * 主进程持有的浏览器全量状态。**事件带全量而不是增量**：标签最多十几条，
 * 代价可忽略，换来的是渲染层不需要自己维护一致性。
 *
 * `revision` 单调递增，渲染层据此丢弃迟到的旧帧（重载后「先订阅、后 getState」
 * 会同时收到事件与快照，靠它去旧）。
 * `epoch` 由主进程在每次渲染进程 bootstrap 时签发，用于丢弃过期的 syncView 上报 ——
 * 刻意不用渲染层自己数的计数器：组件重载后本地计数从同一个初值重新开始，分不出新旧。
 */
export type BrowserState = BrowserTabsCore & { epoch: number };

/**
 * `browser.tabsChanged` 广播的载荷。**刻意不含 epoch**，所以它不能直接复用 BrowserState。
 *
 * epoch 这道闸的全部意义在于「只有 getState 的调用方才知道自己的代号」。广播里带上它
 * 就等于把代号发给了所有人：主进程在新 renderer bootstrap 时签发 epoch=7，而正在被替换掉的
 * **旧** renderer 的 ResizeObserver 还没拆，它收到这条广播拿到 7，用 7 上报**旧布局**的
 * bounds，主进程判定为当前 epoch 并接受 → 原生 WebContentsView 定位到旧几何，全程不报错。
 *
 * 类型挡住的是**读**：渲染层拿到的载荷上没有 epoch 这个字段，写 `payload.epoch` 编译不过。
 * 挡不住的是**写**：`emit('browser.tabsChanged', state)` 传一个 BrowserState 变量在结构
 * 类型下照样通过（超额属性检查只管对象字面量），epoch 会跟着上线。
 *
 * **所以广播那一处必须显式投影**，这是当下唯一成立的要求，没有别的东西替它把关：
 *
 * ```ts
 * const { epoch: _epoch, ...snapshot } = this.registry.toState();
 * broadcaster.emit('browser.tabsChanged', snapshot);
 * ```
 *
 * 把「写」这一侧也焊死要等到那次投影落地之后：那时给本类型加 `epoch?: never`，
 * 传整份 BrowserState 就编译不过了。**它成立的前提是 BrowserState 不再从本类型
 * 交叉派生**（现在两者各自从 BrowserTabsCore 派生，正是为此留的口子）。交叉派生时
 * 加 `epoch?: never` 得到的是 `never & number = never`，整个 BrowserState 塌成 never：
 * tsc 会在 tabRegistry / browserTools 一带报一屏 "reduced to 'never'"，而真正该报错的
 * 那行 emit 反而一声不吭。
 */
export type BrowserTabsSnapshot = BrowserTabsCore;

/**
 * 一次主 frame 导航的观测结果。**任何可能引发导航的操作都要带它**，不只是 browser.open ——
 * 2026-09-07 侦察实测：Google Scholar 的 403 出现在「点提交按钮」之后，检索这件事发生在
 * browser_act 里；只给 open 补状态码等于把字段补在拿不到它的地方。
 *
 * 终态互不合并（照注释砍掉 download 那一支的话，打一个 PDF 直链就只剩 timeout，
 * 而 spec §4.4 要的正是这一支）。**timeout 只留给「我们没能收到任何事实」** ——
 * 凡是我们其实知道发生了什么的路，都要有自己的终态，否则 agent 白等一个时限
 * 还拿到一个错的分类：
 * - ok：跨文档导航提交成功。`httpStatusCode` 来自 did-navigate 的 httpResponseCode ——
 *   **403 是一次成功的导航**，did-fail-load 不触发，只有这个字段看得见它。
 * - ok_same_document：同文档导航（hash / pushState / SPA 路由）。它既不触发
 *   did-navigate 也不触发 did-fail-load，从前整条路只能等满时限报 timeout。
 *   **不并进 ok**：同文档没有 HTTP 响应（没有 httpStatusCode 可填），而且跨文档
 *   意味着 DOM 全换、快照身份要重发号，同文档意味着 DOM 大体还在 —— 下游的快照
 *   diff 要这个区别，合并就等于把它丢了。
 * - failed：did-fail-load。`errorCode` 是 number（Electron 的类型如此），不是字符串。
 * - crashed：渲染进程没了。**不借用 ERR_FAILED(-2)**：借了之后「重开一次多半就好」
 *   与「网络层拒绝、该换源」只能靠 errorDesc 里的中文前缀区分，那是拿文案当协议事实。
 * - download：导航变成了文件下载。一期一律取消下载，但**必须如实报成这个**，
 *   否则打一个 PDF 直链只会得到 timeout，agent 会据此误判源不可达并换源。
 *   只有**与本次导航请求过的 URL 对得上**的下载才算（会话级的 will-download 本来
 *   与某一次导航没有关联，一个广告 frame 拉起的下载会被模型当成论文 PDF）。
 * - blocked：被 KyDog 自己的 URL 闸挡下（§5.1）。我们明确知道发生了什么。
 *   `reason` 只能来自 urlGuard 的 verdict —— 它从不回显原串，含凭据的 URL 不进模型上下文。
 * - superseded：这次观测被另一次导航接替了（用户在 agent 的 open 在途时点了刷新）。
 *   **它的收尾绝不能 stop()**，那掐掉的是接替它的那一次导航；判断与动作一起放在
 *   `NavigationTracker.onTimeout(stop)` 里，调用方没有记错的余地。
 * - timeout：到时限没有明确终态。**不许当成 failed** —— 一个是网络明确拒绝，
 *   一个是我们不知道。超时后主进程会 stop() 并作废这个 navigationId。
 *   `abortObserved` 是唯一带出来的观测事实：主 frame 期间被 ERR_ABORTED 中断过 ——
 *   单独看它不足以定论（下载接管、用户停止、被新导航取代都给这个码），但丢掉它，
 *   工具就只会说「我们不知道发生了什么」。
 */
export type NavigationObservation = {
  navigationId: string;
  outcome:
    | { kind: 'ok'; finalUrl: string; httpStatusCode: number }
    | { kind: 'ok_same_document'; finalUrl: string }
    | { kind: 'failed'; errorCode: number; errorDesc: string }
    | { kind: 'crashed'; reason: string }
    | { kind: 'download'; url: string; mimeType: string; filename: string; cancelled: 'policy' }
    | { kind: 'blocked'; reason: string }
    | { kind: 'superseded' }
    // 标签在观测在途时被销毁（关标签 / run 回收 / 退出）。与 superseded 分开：
    // 那是「被另一次导航接替，页面状态由那一次决定」，这里根本没有页面了。
    | { kind: 'cancelled' }
    | { kind: 'timeout'; abortObserved: boolean };
};

/**
 * CARSI 机构清单里的一条。
 *
 * **名字与 entityID 都不是唯一键**（2026-09-08 实测、2026-09-09 复测 CNKI 那份清单）：
 * 1064 个机构里只有 938 个不同 entityID、936 个不同 host ——
 * `https://passport.escience.cn/idp/shibboleth` 一个 entityID 就被 127 个中科院所共用，
 * 它们走同一套认证，机构名只是 SP 显示用的标签。
 *
 * 「走同一套认证」不是统计推断，是**演绎**，依据在
 * `src/skills/slowpaper/references/carsi.md` §二（标注实测）：SP 入口 URL 的形态是
 * `…/Shibboleth.sso/Login?entityID=<entityID>&target=<…>`，**只有 entityID 上路**，
 * 机构名一个字节都不离开本机 —— 于是那 127 条产生的是**逐字节相同**的 URL。
 * 同文件 §三有那一组的实测样本（登录页 host `passport.escience.cn`、字段
 * `j_username`/`j_password`、无验证码）。
 * **这条演绎成立的前提是「登录 URL 只由 entityID 构造」**：拼 URL 时若把 `name` 也带上，
 * 它当场就断了，而不会有任何东西报错。
 *
 * 所以选中项要**两个一起存**：登录只需要 entityID，名字是给用户看的。理由是
 * **entityID → 名字是一对多**，光有 entityID 反查不出用户当初选的是哪一家
 *（那 127 个所会全部匹配）。这与「同名要消歧」是相反的方向：实测这份快照里
 * 重名为 0 条（`parseIdpList` 的 `ambiguousNames`），今天没有两行一样的文字。
 */
export type IdpEntry = {
  name: string;
  entityID: string;
  /**
   * 清单原文里 entityID 前面那个标志（`"1|https://…"` 的 `1`）。实测 federation=2 那份
   * 是 "1"×1045 / "0"×19，**含义未知**；federation=1 那份是裸 entityID，没有这个前缀。
   *
   * 一期不拿它过滤（猜错会让用户在列表里找不到自己的学校且不报错），但也不在解析层丢掉 ——
   * 源接口给的字节是协议层事实，丢在上游下游就再也拿不回来。
   *
   * **必填**：`null` 才是「源里确实没有前缀」。写成可选的话，「源里没有」与
   * 「解析层忘了带」在类型上长得一样，而后者是一次上游丢信号。
   */
  flag: string | null;
};

/**
 * `institution.listIdps` 的返回。**光有 `entries` 不够。**
 *
 * fsso.cnki.net 抓不到时会回落到落盘的上一次清单；而一份空的 `entries` 在设置页上
 * 等于「这个 SP 一个机构都没有」—— 「我没抓到」与「它真的没有」长得一模一样。
 * 所以每次都要说清楚**这份东西是哪来的、什么时候的**：
 *
 * - `entries`：这一次真正拿给用户看的那份。
 * - `fetchedAt`：**这份 entries 是什么时候抓的**（ISO 8601 字符串）。回落时是旧清单
 *   落盘时记下的那个时刻，**不是这次调用的时间** —— 它描述的是数据，不是调用。
 * - `stale`：`true` = `entries` 来自磁盘（这次没去抓，或者抓了没成）；
 *   `false` = 就是这次抓回来的。
 *
 * 注意 `stale: true` 有两种成因（没去抓 / 抓了没成），本类型不区分它们：设置页对两者
 * 要做的事一样（把 `fetchedAt` 摆出来，给一个「刷新」按钮）。真正必须分开的是
 * 「抓不到」与「读不懂」，那两件事分在两个错误码上（见 errors.ts 的 institution.idp_list_*）。
 */
export type IdpListPublic = {
  entries: IdpEntry[];
  fetchedAt: string;
  stale: boolean;
};

/**
 * 用户在首次填充前确认过的那个真实登录页。
 *
 * **两个字段缺一不可，它们各挡一件事**：
 *
 * - `entityID` —— 确认是**对着某一所学校**做的。不绑定的话，用户先配北大（确认过
 *   iaaa.pku.edu.cn）、后来改选清华并换成清华的学号密码，判据里 confirmedLogins 那一支
 *   直接命中、entityID 根本不参与 → 主进程会把清华账号密码填进北大的统一身份认证页。
 *   与所在记录的 `entityID` 不符的条目即被剔除（读写两条路径都当场把它从数组里滤掉）。
 * - `origin` —— 连 scheme 一起记，形状就是 `new URL(u).origin`（`scheme://host[:port]`）。
 *   只记 host 的话，同一个 Wi-Fi 上应答 `http://iaaa.pku.edu.cn/` 就绕过去了 ——
 *   urlGuard 明确放行 http。
 *
 * 为什么需要「确认」这一步：实测北大的 entityID 是 idp.pku.edu.cn，登录表单却在
 * iaaa.pku.edu.cn（IdP 又跳了一次到学校的统一身份认证），严格按 entityID 的 host
 * 比对会在北大直接拒绝填充。
 */
export type ConfirmedLogin = {
  entityID: string;
  origin: string;
};

/** 落盘形状。只在主进程内部流转 —— 渲染层拿到的是 InstitutionPublic。 */
export type InstitutionRecord = {
  name: string;
  entityID: string;
  username: string;
  /** safeStorage 密文的 base64。空串表示「配了机构与账号，但还没设密码」。 */
  passwordEnc: string;
  /**
   * 已确认的登录页，**可以有多个**。一所学校的登录流程可以在两个 origin 之间跳转；
   * 只留一条的话，确认第二个会覆盖第一个，下次又问，来回没完。
   *
   * **没有上限，这是刻意的**：这个列表只能靠用户每次点一下「是」来增长，攻击者
   * 无法自行追加；而任何「满了就淘汰最旧的」策略都会在 N 条之后原样重现上面那个
   * 来回问的毛病。别把「没有上限」当成漏做。
   */
  confirmedLogins: ConfirmedLogin[];
};

/**
 * 机构账号里**可以给渲染层看的部分**。密码只会 渲染层 → 主进程 单向流动，
 * 永远不回传（连密文也不回）—— 渲染层没有任何用得上它的地方。
 *
 * 这不只是 institution.get 的返回类型：app.bootstrap / settings.get / settings.update /
 * locale.set 四条也各回一份 SettingsFile，`InstitutionRecord` 放不进那个形状里，
 * 于是主进程收口处必须转换（见 SettingsFileForRenderer）。
 */
export type InstitutionPublic = {
  name: string;
  entityID: string;
  username: string;
  hasPassword: boolean;
  confirmedLogins: ConfirmedLogin[];
} | null;

export type InstitutionSaveArgs = {
  name: string;
  entityID: string;
  username: string;
  /** 省略 = 不改动已存的密码；null = 清除；字符串 = 设为新值。 */
  password?: string | null;
  /**
   * 省略 = 保留已确认的那些登录页（前提是 entityID 没变；变了无论如何都作废）；
   * `[]` = 显式全部作废，下次填充前重新问一次。
   *
   * **只有清空这一档，没有「设成某个值」**：一次确认只能由 browser_login 在真的问过
   * 用户之后经 `settingsService.confirmLogin(entityID, origin)` 追加 —— 那是一次锁内的
   * read-modify-write，记录已改或已删时会放弃这次确认。设置页能凭空指定一个 origin 的话，
   * 这道确认就成了摆设。
   */
  confirmedLogins?: [];
};
