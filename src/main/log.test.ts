// src/main/log.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redactSecrets } from './log';

describe('redactSecrets', () => {
  it('redacts apiKey at any nesting', () => {
    const input = { provider: { apiKey: 'sk-abc', model: 'x' } };
    expect(redactSecrets(input)).toEqual({ provider: { apiKey: '[REDACTED]', model: 'x' } });
  });
  it('redacts Authorization header', () => {
    expect(redactSecrets({ headers: { Authorization: 'Bearer xx' } })).toEqual({
      headers: { Authorization: '[REDACTED]' },
    });
  });
  it('handles arrays', () => {
    expect(redactSecrets([{ apiKey: 'a' }])).toEqual([{ apiKey: '[REDACTED]' }]);
  });
  it('returns primitives unchanged', () => {
    expect(redactSecrets('hello')).toBe('hello');
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
  });
});
