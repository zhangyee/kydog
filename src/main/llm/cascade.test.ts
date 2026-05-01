import { describe, it, expect } from 'vitest';
import type { SettingsFile } from '../../shared/types';
import { defaultSettings } from '../persist/settingsFile';
import { sweepDefaultsAfterRemove, sweepDefaultsAfterModelListChange } from './cascade';

function settingsWith(): SettingsFile {
  const s = defaultSettings();
  s.llm.providers['anthropic'] = { defaultModel: 'claude-sonnet-4-5' };
  s.llm.auth['anthropic'] = { type: 'api_key', key: 'k' };
  s.llm.defaultProvider = 'anthropic';
  s.llm.defaultModel = 'claude-sonnet-4-5';
  return s;
}

describe('cascade: sweepDefaultsAfterRemove', () => {
  it('移除当前 defaultProvider → 清空全局 default', () => {
    const s = settingsWith();
    const next = sweepDefaultsAfterRemove(s, 'anthropic');
    expect(next.llm.defaultProvider).toBeNull();
    expect(next.llm.defaultModel).toBeNull();
  });

  it('移除非 default 的 provider → 不动 default', () => {
    const s = settingsWith();
    s.llm.providers['openai'] = {};
    const next = sweepDefaultsAfterRemove(s, 'openai');
    expect(next.llm.defaultProvider).toBe('anthropic');
  });

  it('移除会清空 auth/providers/customProviders 内对应条目', () => {
    const s = settingsWith();
    const next = sweepDefaultsAfterRemove(s, 'anthropic');
    expect(next.llm.providers['anthropic']).toBeUndefined();
    expect(next.llm.auth['anthropic']).toBeUndefined();
  });
});

describe('cascade: sweepDefaultsAfterModelListChange', () => {
  it('全局 defaultModel 不在 provider 模型清单 → 清空全局 defaultModel，保留 defaultProvider', () => {
    const s = settingsWith();
    const next = sweepDefaultsAfterModelListChange(s, 'anthropic', ['claude-haiku']);
    expect(next.llm.defaultProvider).toBe('anthropic');
    expect(next.llm.defaultModel).toBeNull();
  });

  it('Provider.defaultModel 不在新清单 → 清空该 provider.defaultModel', () => {
    const s = settingsWith();
    const next = sweepDefaultsAfterModelListChange(s, 'anthropic', ['claude-haiku']);
    expect(next.llm.providers['anthropic'].defaultModel).toBeUndefined();
  });

  it('thread.modelOverride 不在新清单 → 不删字段（只在 sessionFactory 解析时报错）', () => {
    const s = settingsWith();
    const next = sweepDefaultsAfterModelListChange(s, 'anthropic', ['claude-haiku']);
    expect(next.llm.defaultProvider).toBe('anthropic');
  });
});
