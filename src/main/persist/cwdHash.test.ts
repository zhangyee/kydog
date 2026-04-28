// src/main/persist/cwdHash.test.ts
import { describe, it, expect } from 'vitest';
import { cwdHash } from './cwdHash';

describe('cwdHash', () => {
  it('is deterministic for the same path', () => {
    expect(cwdHash('/a/b/c')).toBe(cwdHash('/a/b/c'));
  });
  it('differs for different paths', () => {
    expect(cwdHash('/a/b/c')).not.toBe(cwdHash('/a/b/d'));
  });
  it('returns 8 hex characters', () => {
    expect(cwdHash('/foo')).toMatch(/^[0-9a-f]{8}$/);
  });
});
