import { describe, it, expect } from 'vitest';
import { customProviderSchema, TEMPLATE } from './customProviderSchema';

describe('customProviderSchema', () => {
  it('TEMPLATE 通过校验', () => {
    const data = JSON.parse(TEMPLATE);
    expect(customProviderSchema.safeParse(data).success).toBe(true);
  });

  it('apiKey 空字符串 → 失败', () => {
    const r = customProviderSchema.safeParse({
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      apiKey: '',
      models: [{ id: 'm' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((e) => e.path.includes('apiKey'))).toBe(true);
  });

  it('apiKey 缺失 → 失败', () => {
    const r = customProviderSchema.safeParse({
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      models: [{ id: 'm' }],
    });
    expect(r.success).toBe(false);
  });

  it('models 空数组 → 失败', () => {
    const r = customProviderSchema.safeParse({
      baseUrl: 'http://x', api: 'openai-completions', apiKey: 'k', models: [],
    });
    expect(r.success).toBe(false);
  });

  it('未知 api → 失败', () => {
    const r = customProviderSchema.safeParse({
      baseUrl: 'http://x', api: 'foo', apiKey: 'k', models: [{ id: 'm' }],
    });
    expect(r.success).toBe(false);
  });
});
