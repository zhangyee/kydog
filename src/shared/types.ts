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
  | { type: 'api_key'; key: string }
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
  /** 闸门结果，已含版本与平台自检。false 时 UI 显示「开发态下不上报」并禁用开关。 */
  allowed: boolean;
};

export type SettingsFile = {
  schemaVersion: 7;
  ui: {
    theme: ThemeName;
    locale: 'zh' | 'en';
    workspaceCollapsed: boolean;
    inspectorCollapsed: boolean;
    readingFontSize: ReadingFontSize;
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

/** settings.update 专用 patch：排除 schemaVersion、onboarding、updates 与 telemetry（spec §7）。 */
export type SettingsPatch = {
  ui?: Partial<SettingsFile['ui']>;
  llm?: Partial<SettingsFile['llm']>;
  skills?: Partial<SettingsFile['skills']>;
  tools?: Partial<SettingsFile['tools']>;
  research?: Partial<SettingsFile['research']>;
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

export type BootstrapState = {
  projects: Project[];
  threads: Thread[];
  settings: SettingsFile;
  appVersion: string;
  systemLocale: 'zh' | 'en';
  identity: Identity;
  onboardingRecovery: OnboardingRecovery;
};

// ── Skills（保留旧定义不变）──
export interface SkillFileConflict {
  relPath: string; shippedSha: string; diskSha: string; recordedSha: string | null;
}
export interface PendingSkillConflict { skill: string; conflicts: SkillFileConflict[]; }
export interface SkillSyncStatus {
  installedOrUpgraded: { skill: string; files: string[]; action: 'install' | 'auto-upgrade' }[];
  pendingConflicts: PendingSkillConflict[];
  userSkills: string[];
}
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
