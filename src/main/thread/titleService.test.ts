import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock declarations are hoisted by Vitest — must be at module scope.
// completeSimple 不再是 pi-ai 的根导出（0.83 起是 ModelRuntime 上的方法），
// 所以它在这里是通过被 mock 的 getProviderRegistry 一起给出来的，见 fakeRegistry()。
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

import { titleService } from './titleService';
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

function fakeModel() {
  return { provider: 'openai', id: 'gpt-4o', api: 'openai-completions' };
}

/**
 * ModelRuntime 自己在 completeSimple 里解析凭据，所以这里不再有 apiKey / headers 那一步。
 * 每个 beforeEach 造一份新的，测试通过 `registry.modelRuntime.completeSimple` 改行为。
 */
function fakeRegistry() {
  return {
    modelRuntime: {
      getModel: vi.fn().mockReturnValue(fakeModel()),
      completeSimple: vi.fn(),
    },
  };
}

let registry: ReturnType<typeof fakeRegistry>;

/** 装好一份新的 registry 并让 getProviderRegistry 返回它。 */
function installRegistry() {
  registry = fakeRegistry();
  (getProviderRegistry as any).mockReturnValue(registry);
  return registry;
}

const completeSimple = () => registry.modelRuntime.completeSimple;

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
    (resolveActive as any).mockResolvedValue({ providerId: 'openai', modelId: 'gpt-4o' });
    installRegistry();
    completeSimple().mockResolvedValue(fakeLlmResponse('Speculative decoding basics'));
    (threadService.update as any).mockImplementation(async ({ threadId, title }: any) => ({
      ...fakeThread(title), id: threadId,
    }));
  });

  it('writes the parsed title via threadService.update', async () => {
    await titleService.runGenerate(THREAD_ID, 'Explain speculative decoding');
    expect(threadService.update).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      title: 'Speculative decoding basics',
    });
  });

  it('emits thread.updated with the returned thread', async () => {
    await titleService.runGenerate(THREAD_ID, 'Explain speculative decoding');
    expect(broadcaster.emit).toHaveBeenCalledWith('thread.updated', expect.objectContaining({
      thread: expect.objectContaining({ title: 'Speculative decoding basics' }),
    }));
  });

  it('passes a 60-token budget and a 15s timeout to completeSimple', async () => {
    await titleService.runGenerate(THREAD_ID, 'Explain speculative decoding');
    const opts = completeSimple().mock.calls[0][2];
    expect(opts.maxTokens).toBe(60);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  // 取代原来「apiKey 被转交给 completeSimple」那条：凭据现在由 ModelRuntime 内部解析，
  // 调用方这一侧还剩下的连线就是 resolveActive → getModel → completeSimple 的第一个参数。
  it('feeds completeSimple the model resolved from modelRuntime.getModel', async () => {
    await titleService.runGenerate(THREAD_ID, 'Explain speculative decoding');
    expect(registry.modelRuntime.getModel).toHaveBeenCalledWith('openai', 'gpt-4o');
    const resolved = registry.modelRuntime.getModel.mock.results[0].value;
    expect(completeSimple().mock.calls[0][0]).toBe(resolved);
  });
});

describe('titleService.runGenerate — edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadIndex as any).mockResolvedValue(fakeIndex());
    (resolveActive as any).mockResolvedValue({ providerId: 'openai', modelId: 'gpt-4o' });
    installRegistry();
    (threadService.update as any).mockImplementation(async ({ threadId, title }: any) => ({
      ...fakeThread(title), id: threadId,
    }));
  });

  it('falls back to slice(0, 20) when the LLM call rejects', async () => {
    completeSimple().mockRejectedValue(new Error('rate limit'));
    await titleService.runGenerate(THREAD_ID, 'Explain speculative decoding');
    expect(threadService.update).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      title: 'Explain speculative ', // first 20 codepoints of "Explain speculative decoding"
    });
  });

  it('falls back when the LLM returns a malformed title (over 30 codepoints)', async () => {
    completeSimple().mockResolvedValue(fakeLlmResponse('a'.repeat(50)));
    await titleService.runGenerate(THREAD_ID, 'Explain speculative decoding');
    expect(threadService.update).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      title: 'Explain speculative ',
    });
  });

  it('falls back when response.stopReason === "error"', async () => {
    completeSimple().mockResolvedValue({ stopReason: 'error', content: [], errorMessage: 'oops' });
    await titleService.runGenerate(THREAD_ID, 'Explain speculative decoding');
    expect(threadService.update).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      title: 'Explain speculative ',
    });
  });

  it('does not update when thread already has a non-placeholder title', async () => {
    (loadIndex as any).mockResolvedValue(fakeIndex(fakeThread('Renamed by user')));
    await titleService.runGenerate(THREAD_ID, 'Explain speculative decoding');
    expect(threadService.update).not.toHaveBeenCalled();
    expect(broadcaster.emit).not.toHaveBeenCalled();
  });

  it('does not update when thread vanished mid-flight (race)', async () => {
    completeSimple().mockResolvedValue(fakeLlmResponse('A title'));
    // First loadIndex returns the placeholder thread; second (race re-check) returns empty.
    (loadIndex as any)
      .mockResolvedValueOnce(fakeIndex())
      .mockResolvedValueOnce({ schemaVersion: 1, projects: [], threads: [] });
    await titleService.runGenerate(THREAD_ID, 'Explain speculative decoding');
    expect(threadService.update).not.toHaveBeenCalled();
  });

  it('does not update when user renamed mid-flight', async () => {
    completeSimple().mockResolvedValue(fakeLlmResponse('A title'));
    (loadIndex as any)
      .mockResolvedValueOnce(fakeIndex())                                  // pre-LLM check: placeholder
      .mockResolvedValueOnce(fakeIndex(fakeThread('User picked this')));   // race re-check: changed
    await titleService.runGenerate(THREAD_ID, 'Explain speculative decoding');
    expect(threadService.update).not.toHaveBeenCalled();
  });
});
