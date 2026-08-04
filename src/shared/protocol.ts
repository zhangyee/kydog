import type {
  BootstrapState, Project, Thread, Message, FsNode, SettingsFile, SettingsPatch, SkillSyncStatus,
  SkillEntry, ToolEntry, SkillPreview, SkillCommitArgs, SkillCommitResult,
  ProviderId, CustomProvider, Identity, OnboardingCompleteArgs, OnboardingResult,
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
  | { method: 'skill.getPendingSync'; args: undefined; result: SkillSyncStatus }
  | { method: 'skill.applyOverrides'; args: { operations: { skill: string; files: string[] }[] }; result: SkillSyncStatus }
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
  | { method: 'file.writeText'; args: { path: string; content: string }; result: void }
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
  | { topic: 'oauth.prompt'; payload: { providerId: string; prompt: { message: string; placeholder?: string; allowEmpty?: boolean } } }
  | { topic: 'oauth.success'; payload: { providerId: string } }
  | { topic: 'oauth.error'; payload: { providerId: string; error: string } }
  | { topic: 'thread.updated'; payload: { thread: Thread } }
  | { topic: 'fs.changed'; payload: { projectPath: string } }
  | { topic: 'identity.changed'; payload: Identity };

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
