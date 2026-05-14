import { describe, it, expect } from 'vitest';
import { parseTitle } from './titleService';

describe('parseTitle', () => {
  it('returns trimmed text for a plain title', () => {
    expect(parseTitle('  Speculative decoding for LLMs  ')).toBe('Speculative decoding for LLMs');
  });

  it('strips ASCII straight double quotes', () => {
    expect(parseTitle('"Hello world"')).toBe('Hello world');
  });

  it('strips Chinese curly quotes', () => {
    expect(parseTitle('"量子计算入门"')).toBe('量子计算入门');
  });

  it('strips a leading "Title:" prefix (any case)', () => {
    expect(parseTitle('title: Diffusion models')).toBe('Diffusion models');
    expect(parseTitle('Title:  Vector databases')).toBe('Vector databases');
  });

  it('returns null for empty input after trimming', () => {
    expect(parseTitle('   ')).toBeNull();
    expect(parseTitle('')).toBeNull();
  });

  it('returns null when title exceeds 30 codepoints', () => {
    // 31 ASCII letters
    expect(parseTitle('a'.repeat(31))).toBeNull();
    // 31 CJK characters
    expect(parseTitle('量'.repeat(31))).toBeNull();
  });

  it('accepts exactly 30 codepoints', () => {
    expect(parseTitle('a'.repeat(30))).toBe('a'.repeat(30));
  });
});
