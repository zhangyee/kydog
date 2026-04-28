// src/main/agent/messageNormalizer.test.ts
import { describe, it, expect } from 'vitest';
import { normalizePiMessages, type PiMessage } from './messageNormalizer';

describe('normalizePiMessages', () => {
  it('user message → KyDog user', () => {
    const input: PiMessage[] = [{ role: 'user', content: 'hi' }];
    expect(normalizePiMessages(input)).toEqual([
      { id: expect.any(String), role: 'user', createdAt: expect.any(String), content: 'hi' },
    ]);
  });
  it('assistant text + tool_use + tool_result merges into blocks', () => {
    const input: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'README\n', is_error: false }],
      },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    if (out[0].role === 'assistant') {
      expect(out[0].blocks).toEqual([
        { kind: 'text', text: 'let me check' },
        {
          kind: 'tool_call', id: 't1', name: 'bash', command: 'ls',
          chunks: [{ stream: 'stdout', data: 'README\n' }],
          status: 'ok', exitCode: 0,
        },
      ]);
    }
  });
});
