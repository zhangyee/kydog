import type { SerializedError } from './errors';

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
    };

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

export type SettingsFile = {
  schemaVersion: 4;
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
  onboarding: { completedAt: string | null };
};

/** settings.update 专用 patch：排除 schemaVersion 与 onboarding（spec §7）。 */
export type SettingsPatch = {
  ui?: Partial<SettingsFile['ui']>;
  llm?: Partial<SettingsFile['llm']>;
  skills?: Partial<SettingsFile['skills']>;
  tools?: Partial<SettingsFile['tools']>;
};

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
