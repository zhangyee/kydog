import { describe, it, expect } from 'vitest';
import { mapSystemLocale } from './locale';

describe('mapSystemLocale', () => {
  it('zh 前缀 → zh', () => {
    expect(mapSystemLocale('zh-CN')).toBe('zh');
    expect(mapSystemLocale('zh-Hant-TW')).toBe('zh');
  });
  it('其余 → en', () => {
    expect(mapSystemLocale('en-US')).toBe('en');
    expect(mapSystemLocale('ja')).toBe('en');
    expect(mapSystemLocale('')).toBe('en');
  });
});
