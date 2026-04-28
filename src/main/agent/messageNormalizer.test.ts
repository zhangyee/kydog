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

  it('assistant text + toolCall + toolResult merges into blocks', () => {
    const input: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'ls' } },
        ],
        stopReason: 'toolUse',
        api: 'anthropic' as never,
        provider: 'anthropic' as never,
        model: 'claude-3-5-sonnet',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      },
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'README\n' }],
        isError: false,
        timestamp: Date.now(),
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
          status: 'ok',
        },
      ]);
    }
  });

  it('thinking content → thinking block', () => {
    const input: PiMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should think about this...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
        stopReason: 'stop',
        api: 'anthropic' as never,
        provider: 'anthropic' as never,
        model: 'claude-3-7-sonnet',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('assistant');
    if (out[0].role === 'assistant') {
      expect(out[0].blocks).toEqual([
        { kind: 'thinking', text: 'I should think about this...' },
        { kind: 'text', text: 'Here is my answer.' },
      ]);
    }
  });
});
