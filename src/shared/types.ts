import type { SerializedError } from './errors';

export type Project = { path: string; label?: string; addedAt: string; pinned?: boolean };

export type Thread = {
  id: string;
  projectPath: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
  pinned?: boolean;
};

export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; status?: 'running' | 'done'; durationMs?: number }
  | {
      kind: 'tool_call';
      id: string;
      name: string;
      command?: string;
      chunks: Array<{ stream: 'stdout' | 'stderr'; data: string }>;
      status: 'running' | 'ok' | 'failed';
      exitCode?: number;
    };

export type Message =
  | { id: string; role: 'user'; createdAt: string; content: string }
  | { id: string; role: 'assistant'; createdAt: string; blocks: AssistantBlock[] };

export type FsNode = { name: string; path: string; kind: 'file' | 'dir' };

export type ProviderConfig = {
  kind: 'openai-compat';
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
};

export type ThemeName = 'vellum' | 'porcelain' | 'sepia' | 'midnight' | 'lilac';

export type SettingsFile = {
  schemaVersion: 1;
  ui: {
    theme: ThemeName;
    locale: 'zh';
    workspaceCollapsed: boolean;
    inspectorCollapsed: boolean;
  };
  llm: { provider: ProviderConfig | null };
  skills: { disabledBuiltins: string[] };
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

export interface SkillFileConflict {
  relPath: string;
  shippedSha: string;
  diskSha: string;
  recordedSha: string | null;
}

export interface PendingSkillConflict {
  skill: string;
  conflicts: SkillFileConflict[];
}

export interface SkillSyncStatus {
  installedOrUpgraded: { skill: string; files: string[]; action: 'install' | 'auto-upgrade' }[];
  pendingConflicts: PendingSkillConflict[];
  userSkills: string[];
}

export type SkillEntry = {
  name: string;
  description: string;
  origin: 'builtin' | 'user';
  enabled: boolean;
  dirPath: string;
  kydogVersion?: string;
};

export type ToolEntry = {
  name: string;
  version: string | null;
  path: string;
};

export type SkillCandidate = {
  name: string;
  description: string;
  relPath: string;
  alreadyInstalled: 'builtin' | 'user' | null;
  nameInvalid?: string;
};

export type SkillPreview = {
  srcKind: 'folder' | 'url';
  srcPath: string;
  candidates: SkillCandidate[];
};

export type SkillCommitArgs = {
  srcKind: 'folder' | 'url';
  srcPath: string;
  picks: { name: string; relPath: string }[];
};

export type SkillCommitResult = {
  installed: SkillEntry[];
  skipped: { name: string; reason: SerializedError }[];
  list: SkillEntry[];
};
