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
  // ── 订阅（2）──
  // OAuth piProviderId 必须与 pi-ai 暴露的 OAuthProviderId 一致：anthropic / openai-codex /
  // github-copilot。pi-ai 把 Claude Pro/Max OAuth 与 Anthropic API key 共用 auth['anthropic']，
  // 所以下面 'anthropic' 行同时承载两种 auth 模式（kind=apiKey 但带 oauth 字段；UI 在该
  // provider 的 detail 里同时给出登录按钮 + key 输入框）。
  //
  // Gemini CLI 与 Google Antigravity 曾在这里，pi 0.83 把它们整个删了（CHANGELOG：「Removed
  // built-in Google Gemini CLI and Google Antigravity support」），留着就是 UI 上的死链接。
  // Gemini 本身不受影响 —— 下面 API key 组的 'google' 行照常，Vertex 也在。
  { id: 'openai-codex', displayName: 'ChatGPT (Codex)', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'openai-codex' } },
  { id: 'github-copilot', displayName: 'GitHub Copilot', kind: 'oauth', group: 'subscription',
    oauth: { piProviderId: 'github-copilot',
             helperText: '若提示「model not supported」，请在 VS Code Copilot Chat 模型选择器里启用对应模型。' } },

  // ── API Key（15）──
  // 'anthropic' 是混合行：API key + Claude Pro/Max OAuth 登录共一行
  { id: 'anthropic', displayName: 'Anthropic', kind: 'apiKey', group: 'apiKey',
    oauth: { piProviderId: 'anthropic', helperText: 'Claude Pro/Max 订阅可点登录；或填入 API Key。' },
    apiKey: { envFallback: ['ANTHROPIC_API_KEY'], baseUrlOverridable: true } },
  { id: 'openai', displayName: 'OpenAI', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['OPENAI_API_KEY'], baseUrlOverridable: true } },
  { id: 'deepseek', displayName: 'DeepSeek', kind: 'apiKey', group: 'apiKey',
    apiKey: { envFallback: ['DEEPSEEK_API_KEY'], baseUrlOverridable: true } },
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
