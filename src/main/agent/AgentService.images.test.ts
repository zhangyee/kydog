import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));
vi.mock('../log', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../log')>();
  return { ...mod, logger: { ...mod.logger, error: vi.fn(), warn: vi.fn(), info: vi.fn() } };
});

import { agentService } from './AgentService';
import type { RunEvent } from '../../shared/protocol';

const PNG = { data: 'iVBORw0KGgo=', mimeType: 'image/png' };

/** 与 AgentService.errorTurn.test.ts 同一个假 session 形态；这里 run 是空闲的，model 可配。 */
function attach(threadId: string, input: string[] | undefined) {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const bound = {
    threadId, providerId: 'anthropic', modelId: 'm', cwd: '/x',
    activeMessageId: null as string | null,
    askOpened: new Set<string>(),
    askArgs: new Map<string, { toolName: string; args: unknown }>(),
    runJournal: [] as RunEvent[],
    runStartIndex: null as number | null,
    runId: null as string | null,
    session: {
      prompt, abort: vi.fn(), dispose: vi.fn(),
      state: { messages: [] as unknown[] },
      subscribe: () => () => undefined,
      ...(input ? { model: { input } } : {}),
    },
  };
  (agentService as any).sessions.set(threadId, bound);
  return { prompt };
}

describe('AgentService.send —— 图片按会话实际的模型判', () => {
  beforeEach(() => {
    (agentService as any).sessions.clear();
    (agentService as any).runs.clear();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('模型收图：图片以 pi 的图片块交给 prompt；模型只收文字：同样的请求被拒、prompt 一次没调、run 没被占住', async () => {
    const vision = attach('t-vision', ['text', 'image']);
    await agentService.send('t-vision', '/x', '看图', [PNG]);
    expect(vision.prompt).toHaveBeenCalledWith('看图', { images: [{ type: 'image', data: PNG.data, mimeType: PNG.mimeType }] });

    const text = attach('t-text', ['text']);
    await expect(agentService.send('t-text', '/x', '看图', [PNG])).rejects.toMatchObject({
      code: 'llm.imageUnsupported', message: '当前模型不支持图片输入',
    });
    expect(text.prompt).not.toHaveBeenCalled();
    expect(agentService.getRunState('t-text').status).toBe('idle');
  });

  it('没有图片：只收文字的模型照常发，prompt 只收到一个参数（与改动前的调用形状一致）', async () => {
    const text = attach('t-plain', ['text']);
    await agentService.send('t-plain', '/x', 'hello');
    expect(text.prompt.mock.calls).toEqual([['hello']]);
  });

  it('session 上没有 model（声明缺失）而这一轮带了图：按不收图处理', async () => {
    const none = attach('t-none', undefined);
    await expect(agentService.send('t-none', '/x', '看图', [PNG])).rejects.toMatchObject({ code: 'llm.imageUnsupported' });
    expect(none.prompt).not.toHaveBeenCalled();
    // 正向：同一个 session 不带图照常能发
    await agentService.send('t-none', '/x', 'hi');
    expect(none.prompt).toHaveBeenCalledWith('hi');
  });
});
