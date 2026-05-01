// src/main/llm/catalog.ts
import type { ProviderId } from '../../shared/types';

export type ProviderKind = 'oauth' | 'apiKey' | 'cloud' | 'custom';

export type CatalogEntry = {
  id: ProviderId;
  displayName: string;
  kind: ProviderKind;
  group: 'subscription' | 'apiKey' | 'cloud';
  defaultModel?: string;
  oauth?: {
    piProviderId: string;
    helperText?: string;
  };
  apiKey?: {
    envFallback?: string[];
    docUrl?: string;
    baseUrlOverridable: boolean;
  };
  cloud?: {
    cfgKind: 'azure' | 'bedrock' | 'vertex';
  };
};

export const PROVIDER_CATALOG: CatalogEntry[] = [
  // ── 订阅（5）──
  // OAuth piProviderId 必须与 pi-ai 暴露的 OAuthProviderId 一致，否则 authStorage.login
  // 抛 "Unknown OAuth provider"。pi-ai 当前暴露：anthropic、openai-codex、github-copilot、
  // google-gemini-cli、google-antigravity（见 @mariozechner/pi-ai/dist/utils/oauth）。
  // 4 个无冲突的 catalog id 已与 piProviderId 对齐。'claude' 因与下面 API key 'anthropic' 共
  // 用 pi auth['anthropic'] 槽，保留差异 id 避免 catalog 重复，已知登录后 UI configured 状态
  // 会显示在 'anthropic' 行而非 'claude' 行（待后续合并 spec issue 修）。
  { id: 'claude', displayName: 'Claude Pro/Max', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'anthropic' } },
  { id: 'openai-codex', displayName: 'ChatGPT (Codex)', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'openai-codex' } },
  { id: 'github-copilot', displayName: 'GitHub Copilot', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'github-copilot',
             helperText: '若提示「model not supported」，请在 VS Code Copilot Chat 模型选择器里启用对应模型。' } },
  { id: 'google-gemini-cli', displayName: 'Gemini CLI', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'google-gemini-cli' } },
  { id: 'google-antigravity', displayName: 'Google Antigravity', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'google-antigravity' } },

  // ── API Key（14）──
  { id: 'anthropic', displayName: 'Anthropic', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['ANTHROPIC_API_KEY'], baseUrlOverridable: true } },
  { id: 'openai', displayName: 'OpenAI', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['OPENAI_API_KEY'], baseUrlOverridable: true } },
  { id: 'google', displayName: 'Google Gemini', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['GEMINI_API_KEY'], baseUrlOverridable: false } },
  { id: 'openrouter', displayName: 'OpenRouter', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['OPENROUTER_API_KEY'], baseUrlOverridable: true } },
  { id: 'mistral', displayName: 'Mistral', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['MISTRAL_API_KEY'], baseUrlOverridable: false } },
  { id: 'groq', displayName: 'Groq', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['GROQ_API_KEY'], baseUrlOverridable: false } },
  { id: 'cerebras', displayName: 'Cerebras', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['CEREBRAS_API_KEY'], baseUrlOverridable: false } },
  { id: 'xai', displayName: 'xAI', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['XAI_API_KEY'], baseUrlOverridable: false } },
  { id: 'vercel-ai-gateway', displayName: 'Vercel AI Gateway', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['AI_GATEWAY_API_KEY'], baseUrlOverridable: true } },
  { id: 'zai', displayName: 'ZAI', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['ZAI_API_KEY'], baseUrlOverridable: false } },
  { id: 'huggingface', displayName: 'Hugging Face', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['HF_TOKEN'], baseUrlOverridable: false } },
  { id: 'kimi-coding', displayName: 'Kimi For Coding', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['KIMI_API_KEY'], baseUrlOverridable: false } },
  { id: 'minimax', displayName: 'MiniMax', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['MINIMAX_API_KEY'], baseUrlOverridable: false } },
  { id: 'opencode', displayName: 'OpenCode Zen', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['OPENCODE_API_KEY'], baseUrlOverridable: false } },

  // ── 云（3）──
  { id: 'azure-openai-responses', displayName: 'Azure OpenAI', kind: 'cloud', group: 'cloud',
    cloud: { cfgKind: 'azure' } },
  { id: 'amazon-bedrock', displayName: 'Amazon Bedrock', kind: 'cloud', group: 'cloud',
    cloud: { cfgKind: 'bedrock' } },
  { id: 'google-vertex', displayName: 'Google Vertex AI', kind: 'cloud', group: 'cloud',
    cloud: { cfgKind: 'vertex' } },
];

const _idMap = new Map(PROVIDER_CATALOG.map((e) => [e.id, e]));
export function getCatalogEntry(id: ProviderId): CatalogEntry | undefined {
  return _idMap.get(id);
}
