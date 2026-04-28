// src/main/log.test.ts
import { describe, it, expect } from 'vitest';
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
  it('redacts when secret value is itself an object', () => {
    expect(redactSecrets({ apiKey: { primary: 'sk-x', backup: 'sk-y' } })).toEqual({
      apiKey: '[REDACTED]',
    });
  });
  it('short-circuits Uint8Array to [Bytes]', () => {
    expect(redactSecrets(new Uint8Array([1, 2, 3]))).toBe('[Bytes]');
  });
  it('handles circular references without throwing', () => {
    const a: any = { x: 1 };
    a.self = a;
    expect(() => redactSecrets(a)).not.toThrow();
    const result = redactSecrets(a) as Record<string, unknown>;
    expect(result['x']).toBe(1);
    expect(result['self']).toBe('[Circular]');
  });
  it('redacts newly-broadened secret keys: token, cookie, secret', () => {
    expect(redactSecrets({ token: 't', cookie: 'c', secret: 's', safe: 'ok' })).toEqual({
      token: '[REDACTED]',
      cookie: '[REDACTED]',
      secret: '[REDACTED]',
      safe: 'ok',
    });
  });
});
