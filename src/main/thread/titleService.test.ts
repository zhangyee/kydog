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

import { extractFirstText } from './titleService';
import type { Message } from '../../shared/types';

describe('extractFirstText', () => {
  const userMsg: Message = { id: 'u1', role: 'user', createdAt: '', content: 'What is X?' };
  const assistantMsg: Message = {
    id: 'a1', role: 'assistant', createdAt: '',
    blocks: [
      { kind: 'thinking', text: 'hmm' },
      { kind: 'text', text: 'X is ' },
      { kind: 'tool_call', id: 't', name: 'bash', chunks: [], status: 'ok' },
      { kind: 'text', text: 'a thing.' },
    ],
  };

  it('returns the user message content', () => {
    expect(extractFirstText([userMsg, assistantMsg], 'user')).toBe('What is X?');
  });

  it('concatenates only text blocks from the assistant message', () => {
    // 'thinking' and 'tool_call' blocks are excluded
    expect(extractFirstText([userMsg, assistantMsg], 'assistant')).toBe('X is a thing.');
  });

  it('returns the first matching message even if later ones exist', () => {
    const second: Message = { id: 'u2', role: 'user', createdAt: '', content: 'later' };
    expect(extractFirstText([userMsg, second], 'user')).toBe('What is X?');
  });

  it('returns null when no matching role exists', () => {
    expect(extractFirstText([userMsg], 'assistant')).toBeNull();
    expect(extractFirstText([], 'user')).toBeNull();
  });

  it('returns null when assistant message has no text blocks', () => {
    const noText: Message = {
      id: 'a', role: 'assistant', createdAt: '',
      blocks: [{ kind: 'thinking', text: 'only thinking' }],
    };
    expect(extractFirstText([noText], 'assistant')).toBeNull();
  });
});
