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
      getApiKeyAndHeaders: vi.fn().mockResolvedValue({ apiKey: 'sk-test', headers: {} }),
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
