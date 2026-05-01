import { describe, it, expect } from 'vitest';
import type { SettingsFile } from '../../shared/types';
import { resolveProviderDefault } from './resolveProvider';
import { defaultSettings } from '../persist/settingsFile';

function fixture(): SettingsFile {
  const s = defaultSettings();
  s.llm.providers['anthropic'] = { defaultModel: 'claude-sonnet-4-5' };
  s.llm.customProviders.push({
    id: 'ollama-local', displayName: 'Ollama', baseUrl: 'http://localhost:11434/v1',
    api: 'openai-completions', apiKey: 'ollama',
    models: [{ id: 'llama3.1:8b' }],
    defaultModel: 'llama3.1:8b',
  });
  s.llm.defaultModel = 'global-fallback-id';
  return s;
}

describe('resolveProviderDefault', () => {
  it('内置 provider 命中 providers[id].defaultModel', () => {
    expect(resolveProviderDefault(fixture(), 'anthropic')).toBe('claude-sonnet-4-5');
  });
  it('自定义 provider 命中 customProviders[].defaultModel', () => {
    expect(resolveProviderDefault(fixture(), 'ollama-local')).toBe('llama3.1:8b');
  });
  it('两源都缺 → undefined（让 sessionFactory 落到全局 defaultModel）', () => {
    const s = fixture();
    delete s.llm.providers['anthropic'].defaultModel;
    expect(resolveProviderDefault(s, 'anthropic')).toBeUndefined();
  });
  it('未知 provider → undefined', () => {
    expect(resolveProviderDefault(fixture(), 'nope')).toBeUndefined();
  });
});
