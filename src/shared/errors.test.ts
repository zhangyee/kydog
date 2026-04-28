import { describe, it, expect } from 'vitest';
import { KydogError, serializeError, isRpcError } from './errors';

describe('serializeError', () => {
  it('KydogError returns {code, message} without leaking cause', () => {
    const cause = new Error('root cause');
    const err = new KydogError('settings.invalid', 'bad settings', cause);
    const result = serializeError(err);
    expect(result).toEqual({ code: 'settings.invalid', message: 'bad settings' });
    expect(result).not.toHaveProperty('cause');
  });

  it('plain Error returns {code: unknown, message: err.message}', () => {
    const err = new Error('plain error');
    expect(serializeError(err)).toEqual({ code: 'unknown', message: 'plain error' });
  });

  it('thrown string returns {code: unknown, message: the string}', () => {
    expect(serializeError('oops')).toEqual({ code: 'unknown', message: 'oops' });
  });

  it('thrown object returns {code: unknown, message: String(obj)}', () => {
    expect(serializeError({ foo: 'bar' })).toEqual({ code: 'unknown', message: '[object Object]' });
  });

  it('thrown null returns {code: unknown, message: "null"}', () => {
    expect(serializeError(null)).toEqual({ code: 'unknown', message: 'null' });
  });
});

describe('isRpcError', () => {
  it('returns true for Error with a string code field', () => {
    const e = new Error('msg') as Error & { code: string };
    e.code = 'unknown';
    expect(isRpcError(e)).toBe(true);
  });

  it('returns false for plain object with code field', () => {
    expect(isRpcError({ code: 'unknown', message: 'x' })).toBe(false);
  });

  it('returns false for Error without code', () => {
    expect(isRpcError(new Error('no code'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isRpcError(null)).toBe(false);
  });

  it('returns false for string', () => {
    expect(isRpcError('error')).toBe(false);
  });

  it('returns false for number', () => {
    expect(isRpcError(42)).toBe(false);
  });
});
