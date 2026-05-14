import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock declarations are hoisted by Vitest — must be at module scope.
vi.mock('@mariozechner/pi-ai', () => ({
  completeSimple: vi.fn(),
}));
vi.mock('../agent/AgentService', () => ({
  agentService: { loadHistory: vi.fn() },
}));
vi.mock('../agent/resolveActive', () => ({
  resolveActive: vi.fn(),
}));
vi.mock('../llm/providerRegistry', () => ({
  getProviderRegistry: vi.fn(),
}));
vi.mock('../persist/indexFile', () => ({
  loadIndex: vi.fn(),
}));
vi.mock('./threadService', () => ({
  threadService: { update: vi.fn() },
}));
vi.mock('../ipc/broadcaster', () => ({
  broadcaster: { emit: vi.fn() },
}));

import { parseTitle } from './titleService';

describe('parseTitle', () => {
  it('returns trimmed text for a plain title', () => {
    expect(parseTitle('  Speculative decoding for LLMs  ')).toBe('Speculative decoding for LLMs');
  });

  it('strips ASCII straight double quotes', () => {
    expect(parseTitle('"Hello world"')).toBe('Hello world');
  });

  it('strips Chinese curly quotes', () => {
    expect(parseTitle('“量子计算入门”')).toBe('量子计算入门');
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

import { extractText } from './titleService';
import type { Message } from '../../shared/types';

describe('extractText', () => {
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
    expect(extractText([userMsg, assistantMsg], 'user')).toBe('What is X?');
  });

  it('concatenates only text blocks from the assistant message', () => {
    // 'thinking' and 'tool_call' blocks are excluded
    expect(extractText([userMsg, assistantMsg], 'assistant')).toBe('X is a thing.');
  });

  it('returns the first matching message even if later ones exist', () => {
    const second: Message = { id: 'u2', role: 'user', createdAt: '', content: 'later' };
    expect(extractText([userMsg, second], 'user')).toBe('What is X?');
  });

  it('returns null when no matching role exists', () => {
    expect(extractText([userMsg], 'assistant')).toBeNull();
    expect(extractText([], 'user')).toBeNull();
  });

  it('returns null when assistant message has no text blocks', () => {
    const noText: Message = {
      id: 'a', role: 'assistant', createdAt: '',
      blocks: [{ kind: 'thinking', text: 'only thinking' }],
    };
    expect(extractText([noText], 'assistant')).toBeNull();
  });

  it('concatenates text across multiple assistant messages (tool-heavy turn)', () => {
    // Real-world shape from pi: each tool round produces its own assistant message;
    // the first one is typically thinking+toolCall only, with the actual text answer
    // appearing in a later assistant message.
    const history: Message[] = [
      { id: 'u1', role: 'user', createdAt: '', content: '问题' },
      { id: 'a1', role: 'assistant', createdAt: '', blocks: [
        { kind: 'thinking', text: 'let me search' },
        { kind: 'tool_call', id: 't1', name: 'web_search', chunks: [], status: 'ok' },
      ] },
      { id: 'a2', role: 'assistant', createdAt: '', blocks: [
        { kind: 'thinking', text: 'now I know' },
        { kind: 'tool_call', id: 't2', name: 'fetch', chunks: [], status: 'ok' },
      ] },
      { id: 'a3', role: 'assistant', createdAt: '', blocks: [
        { kind: 'text', text: 'Final answer goes here.' },
      ] },
    ];
    expect(extractText(history, 'assistant')).toBe('Final answer goes here.');
  });

  it('concatenates multiple text blocks across multiple assistant messages', () => {
    const history: Message[] = [
      { id: 'a1', role: 'assistant', createdAt: '', blocks: [
        { kind: 'text', text: 'Let me think.' },
        { kind: 'tool_call', id: 't', name: 'x', chunks: [], status: 'ok' },
      ] },
      { id: 'a2', role: 'assistant', createdAt: '', blocks: [
        { kind: 'text', text: 'OK got it: 42.' },
      ] },
    ];
    expect(extractText(history, 'assistant')).toBe('Let me think.\nOK got it: 42.');
  });

  it('returns null when no assistant message has any text block (only tool calls)', () => {
    const history: Message[] = [
      { id: 'u', role: 'user', createdAt: '', content: 'hi' },
      { id: 'a1', role: 'assistant', createdAt: '', blocks: [
        { kind: 'thinking', text: 'thinking' },
        { kind: 'tool_call', id: 't', name: 'x', chunks: [], status: 'ok' },
      ] },
      { id: 'a2', role: 'assistant', createdAt: '', blocks: [
        { kind: 'thinking', text: 'more thinking' },
      ] },
    ];
    expect(extractText(history, 'assistant')).toBeNull();
  });
});

import { titleService } from './titleService';
import { completeSimple } from '@mariozechner/pi-ai';
import { agentService } from '../agent/AgentService';
import { resolveActive } from '../agent/resolveActive';
import { getProviderRegistry } from '../llm/providerRegistry';
import { loadIndex } from '../persist/indexFile';
import { threadService } from './threadService';
import { broadcaster } from '../ipc/broadcaster';

const THREAD_ID = 't1';
const PROJECT = '/p';

function fakeThread(title = '无标题') {
  return { id: THREAD_ID, projectPath: PROJECT, title, createdAt: '', lastActiveAt: '' };
}

function fakeIndex(thread = fakeThread()) {
  return { schemaVersion: 1, projects: [], threads: [thread] };
}

function fakeHistory() {
  return [
    { id: 'u1', role: 'user', createdAt: '', content: 'Explain speculative decoding' },
    { id: 'a1', role: 'assistant', createdAt: '', blocks: [{ kind: 'text', text: 'It is a sampling trick.' }] },
  ];
}

function fakeModel() {
  return { provider: 'openai', id: 'gpt-4o', api: 'openai-completions' };
}

function fakeRegistry() {
  return {
    modelRegistry: {
      find: vi.fn().mockReturnValue(fakeModel()),
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: 'sk-test', headers: {} }),
    },
  };
}

function fakeLlmResponse(text: string) {
  return {
    stopReason: 'end_turn',
    content: [{ type: 'text', text }],
  };
}

describe('titleService.runGenerate — happy path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadIndex as any).mockResolvedValue(fakeIndex());
    (agentService.loadHistory as any).mockResolvedValue(fakeHistory());
    (resolveActive as any).mockResolvedValue({ providerId: 'openai', modelId: 'gpt-4o' });
    (getProviderRegistry as any).mockReturnValue(fakeRegistry());
    (completeSimple as any).mockResolvedValue(fakeLlmResponse('Speculative decoding basics'));
    (threadService.update as any).mockImplementation(async ({ threadId, title }: any) => ({
      ...fakeThread(title), id: threadId,
    }));
  });

  it('writes the parsed title via threadService.update', async () => {
    await titleService.runGenerate(THREAD_ID);
    expect(threadService.update).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      title: 'Speculative decoding basics',
    });
  });

  it('emits thread.updated with the returned thread', async () => {
    await titleService.runGenerate(THREAD_ID);
    expect(broadcaster.emit).toHaveBeenCalledWith('thread.updated', expect.objectContaining({
      thread: expect.objectContaining({ title: 'Speculative decoding basics' }),
    }));
  });

  it('passes a 60-token budget and a 15s timeout to completeSimple', async () => {
    await titleService.runGenerate(THREAD_ID);
    const opts = (completeSimple as any).mock.calls[0][2];
    expect(opts.maxTokens).toBe(60);
    expect(opts.apiKey).toBe('sk-test');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('titleService.runGenerate — edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadIndex as any).mockResolvedValue(fakeIndex());
    (agentService.loadHistory as any).mockResolvedValue(fakeHistory());
    (resolveActive as any).mockResolvedValue({ providerId: 'openai', modelId: 'gpt-4o' });
    (getProviderRegistry as any).mockReturnValue(fakeRegistry());
    (threadService.update as any).mockImplementation(async ({ threadId, title }: any) => ({
      ...fakeThread(title), id: threadId,
    }));
  });

  it('falls back to slice(0, 20) when the LLM call rejects', async () => {
    (completeSimple as any).mockRejectedValue(new Error('rate limit'));
    await titleService.runGenerate(THREAD_ID);
    expect(threadService.update).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      title: 'Explain speculative ', // first 20 codepoints of "Explain speculative decoding"
    });
  });

  it('falls back when the LLM returns a malformed title (over 30 codepoints)', async () => {
    (completeSimple as any).mockResolvedValue(fakeLlmResponse('a'.repeat(50)));
    await titleService.runGenerate(THREAD_ID);
    expect(threadService.update).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      title: 'Explain speculative ',
    });
  });

  it('falls back when response.stopReason === "error"', async () => {
    (completeSimple as any).mockResolvedValue({ stopReason: 'error', content: [], errorMessage: 'oops' });
    await titleService.runGenerate(THREAD_ID);
    expect(threadService.update).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      title: 'Explain speculative ',
    });
  });

  it('does not update when thread already has a non-placeholder title', async () => {
    (loadIndex as any).mockResolvedValue(fakeIndex(fakeThread('Renamed by user')));
    await titleService.runGenerate(THREAD_ID);
    expect(threadService.update).not.toHaveBeenCalled();
    expect(broadcaster.emit).not.toHaveBeenCalled();
  });

  it('does not update when thread vanished mid-flight (race)', async () => {
    (completeSimple as any).mockResolvedValue(fakeLlmResponse('A title'));
    // First loadIndex returns the placeholder thread; second (race re-check) returns empty.
    (loadIndex as any)
      .mockResolvedValueOnce(fakeIndex())
      .mockResolvedValueOnce({ schemaVersion: 1, projects: [], threads: [] });
    await titleService.runGenerate(THREAD_ID);
    expect(threadService.update).not.toHaveBeenCalled();
  });

  it('does not update when user renamed mid-flight', async () => {
    (completeSimple as any).mockResolvedValue(fakeLlmResponse('A title'));
    (loadIndex as any)
      .mockResolvedValueOnce(fakeIndex())                                  // pre-LLM check: placeholder
      .mockResolvedValueOnce(fakeIndex(fakeThread('User picked this')));   // race re-check: changed
    await titleService.runGenerate(THREAD_ID);
    expect(threadService.update).not.toHaveBeenCalled();
  });

  it('returns silently when history has no assistant message', async () => {
    (agentService.loadHistory as any).mockResolvedValue([
      { id: 'u1', role: 'user', createdAt: '', content: 'Hi' },
    ]);
    await titleService.runGenerate(THREAD_ID);
    expect(completeSimple).not.toHaveBeenCalled();
    expect(threadService.update).not.toHaveBeenCalled();
  });
});
