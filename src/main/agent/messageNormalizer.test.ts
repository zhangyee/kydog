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
        { kind: 'thinking', text: 'I should think about this...', status: 'done' },
        { kind: 'text', text: 'Here is my answer.' },
      ]);
    }
  });

  // ── 聚合：一个 turn 内 pi 把内容切成多条 assistant message，应合并为一条 KyDog Message ──

  it('一个 turn 内 assistant→toolResult→assistant→toolResult→assistant 合并为单条 KyDog Message', () => {
    const input: PiMessage[] = [
      { role: 'user', content: '搜一下 ECG 重建论文' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '我先想想' },
          { type: 'toolCall', id: 't1', name: 'search_papers', arguments: { q: 'ECG' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 't1', toolName: 'search_papers',
        content: [{ type: 'text', text: '找到 10 篇' }],
        isError: false,
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '再换个方向' },
          { type: 'toolCall', id: 't2', name: 'search_arxiv', arguments: { q: 'reconstruct' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 't2', toolName: 'search_arxiv',
        content: [{ type: 'text', text: '找到 5 篇' }],
        isError: false,
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '结合两次搜索结果...' }],
      },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
    expect(out[1].role).toBe('assistant');
    if (out[1].role === 'assistant') {
      expect(out[1].blocks.map(b => b.kind)).toEqual([
        'thinking', 'tool_call', 'thinking', 'tool_call', 'text',
      ]);
      // tool_call 仍正确填入 chunks（toolResult 不出现在 top-level）
      const tools = out[1].blocks.filter(b => b.kind === 'tool_call');
      expect(tools).toHaveLength(2);
      if (tools[0].kind === 'tool_call') expect(tools[0].chunks).toEqual([{ stream: 'stdout', data: '找到 10 篇' }]);
      if (tools[1].kind === 'tool_call') expect(tools[1].chunks).toEqual([{ stream: 'stdout', data: '找到 5 篇' }]);
    }
  });

  it('两个 turn（user 分隔）：每个 turn 各自聚合，独立成条', () => {
    const input: PiMessage[] = [
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: [{ type: 'text', text: '回答 A1' }] },
      { role: 'assistant', content: [{ type: 'text', text: '回答 A2' }] },
      { role: 'user', content: '第二轮' },
      { role: 'assistant', content: [{ type: 'text', text: '回答 B' }] },
    ];
    const out = normalizePiMessages(input);
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    if (out[1].role === 'assistant') {
      expect(out[1].blocks).toEqual([
        { kind: 'text', text: '回答 A1' },
        { kind: 'text', text: '回答 A2' },
      ]);
    }
    if (out[3].role === 'assistant') {
      expect(out[3].blocks).toEqual([{ kind: 'text', text: '回答 B' }]);
    }
  });

  it('末尾连续 assistant 在循环结束时被 flush，不丢失', () => {
    const input: PiMessage[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    ];
    const out = normalizePiMessages(input);
    expect(out).toHaveLength(1);
    if (out[0].role === 'assistant') {
      expect(out[0].blocks).toEqual([
        { kind: 'text', text: 'a' },
        { kind: 'text', text: 'b' },
      ]);
    }
  });

  it('空数组返回空', () => {
    expect(normalizePiMessages([])).toEqual([]);
  });

  it('仅 user，无 assistant：照常返回', () => {
    const out = normalizePiMessages([
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every(m => m.role === 'user')).toBe(true);
  });
});
