export type Project = { path: string; label?: string; addedAt: string };

export type Thread = {
  id: string;
  projectPath: string;
  title: string;
  createdAt: string;
  lastActiveAt: string;
};

export type AssistantBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
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

export type SettingsFile = {
  schemaVersion: 1;
  ui: {
    theme: 'vellum' | 'midnight';
    locale: 'zh';
    workspaceCollapsed: boolean;
    inspectorCollapsed: boolean;
  };
  llm: { provider: ProviderConfig | null };
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
