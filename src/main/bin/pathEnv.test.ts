import { describe, it, expect } from 'vitest';
import { computePathPrefix } from './pathEnv';

describe('computePathPrefix', () => {
  it('prepends binDir on posix', () => {
    expect(computePathPrefix('/bin', '/usr/bin:/bin', ':')).toBe('/bin:/usr/bin:/bin');
  });
  it('prepends binDir on win32 with semicolon', () => {
    expect(computePathPrefix('C:\\KyDog', 'C:\\WINDOWS;C:\\System32', ';'))
      .toBe('C:\\KyDog;C:\\WINDOWS;C:\\System32');
  });
  it('handles empty existing PATH', () => {
    expect(computePathPrefix('/bin', '', ':')).toBe('/bin');
    expect(computePathPrefix('/bin', undefined, ':')).toBe('/bin');
  });
  it('skips if binDir already prefix-equal', () => {
    expect(computePathPrefix('/bin', '/bin:/usr/bin', ':')).toBe('/bin:/usr/bin');
  });
});
