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
  { id: 'claude', displayName: 'Claude Pro/Max', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'claude' } },
  { id: 'codex', displayName: 'ChatGPT (Codex)', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'codex' } },
  { id: 'github-copilot', displayName: 'GitHub Copilot', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'github-copilot',
             helperText: '若提示「model not supported」，请在 VS Code Copilot Chat 模型选择器里启用对应模型。' } },
  { id: 'gemini-cli', displayName: 'Gemini CLI', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'gemini-cli' } },
  { id: 'antigravity', displayName: 'Google Antigravity', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'antigravity' } },

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
