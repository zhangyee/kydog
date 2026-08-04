export type CatalogApiKeyMeta = {
  envFallback?: string[];
  baseUrlOverridable: boolean;
};

export const STATIC_META: Record<string, CatalogApiKeyMeta> = {
  anthropic: { envFallback: ['ANTHROPIC_API_KEY'], baseUrlOverridable: true },
  openai: { envFallback: ['OPENAI_API_KEY'], baseUrlOverridable: true },
  deepseek: { envFallback: ['DEEPSEEK_API_KEY'], baseUrlOverridable: true },
  google: { envFallback: ['GEMINI_API_KEY'], baseUrlOverridable: false },
  openrouter: { envFallback: ['OPENROUTER_API_KEY'], baseUrlOverridable: true },
  mistral: { envFallback: ['MISTRAL_API_KEY'], baseUrlOverridable: false },
  groq: { envFallback: ['GROQ_API_KEY'], baseUrlOverridable: false },
  cerebras: { envFallback: ['CEREBRAS_API_KEY'], baseUrlOverridable: false },
  xai: { envFallback: ['XAI_API_KEY'], baseUrlOverridable: false },
  'vercel-ai-gateway': { envFallback: ['AI_GATEWAY_API_KEY'], baseUrlOverridable: true },
  zai: { envFallback: ['ZAI_API_KEY'], baseUrlOverridable: false },
  huggingface: { envFallback: ['HF_TOKEN'], baseUrlOverridable: false },
  'kimi-coding': { envFallback: ['KIMI_API_KEY'], baseUrlOverridable: false },
  minimax: { envFallback: ['MINIMAX_API_KEY'], baseUrlOverridable: false },
  opencode: { envFallback: ['OPENCODE_API_KEY'], baseUrlOverridable: false },
};
