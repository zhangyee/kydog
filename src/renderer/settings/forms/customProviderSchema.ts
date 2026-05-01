import { z } from 'zod';

export const customProviderSchema = z.object({
  baseUrl: z.string().url('baseUrl 必须是合法 URL'),
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']),
  apiKey: z.string().min(1, 'apiKey 必填；本地 LLM 可填占位字符串如 "ollama"'),
  headers: z.record(z.string(), z.string()).optional(),
  authHeader: z.boolean().optional(),
  models: z.array(z.object({
    id: z.string().min(1),
    name: z.string().optional(),
    api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']).optional(),
    reasoning: z.boolean().optional(),
    input: z.array(z.enum(['text', 'image'])).optional(),
    contextWindow: z.number().optional(),
    maxTokens: z.number().optional(),
    cost: z.object({
      input: z.number(), output: z.number(),
      cacheRead: z.number().optional(), cacheWrite: z.number().optional(),
    }).optional(),
    compat: z.record(z.string(), z.unknown()).optional(),
  })).min(1, '至少一个 model'),
  defaultModel: z.string().optional(),
  compat: z.record(z.string(), z.unknown()).optional(),
});

export type CustomProviderJson = z.infer<typeof customProviderSchema>;

export const TEMPLATE = JSON.stringify({
  baseUrl: 'http://localhost:11434/v1',
  api: 'openai-completions',
  apiKey: 'ollama',
  models: [{ id: 'llama3.1:8b' }],
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
}, null, 2);
