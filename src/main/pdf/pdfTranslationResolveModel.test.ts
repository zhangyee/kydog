import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SettingsFile } from '../../shared/types';

/**
 * `pdfTranslation.resolveModel` 的三段接线（不变量 #10「一趟作业同一个模型 + 同一份运行时」的
 * 起点），此前全链路零覆盖：
 *
 *   1. `resolveActive` 抛的 `ResolveError` 转码成 `llm.not_configured`（渲染层的
 *      `translateDoc` 按这个 **code** 分派「不重试、中止整趟」，不匹配 message 字符串）；
 *   2. 前置 `getModel` 校验——设置里留着一个已经不存在的 model id 时，必须在这里就抛，而不是
 *      让用户先等抽完整份 PDF 再在第一页调用上看到同一句话；
 *   3. `runtimeRevision` 透传——作业开始钉住的那一份，`pdfTranslatePage` 逐页拿它比对。
 *
 * e2e 也覆盖不到 2 和 3：fixture 分支在 `pdfTranslatePage.ts` 里 `return` 在这两道校验**之前**。
 *
 * 替身只打在 `resolveActive` 的两个上游（settings / thread）与 registry 上——`resolveActive`
 * 本身与它抛的那个真 `ResolveError` 都跑真的，否则「转码」这条断言就只是在测替身。
 */

const state = vi.hoisted(() => ({
  settings: null as unknown as SettingsFile,
  threads: [] as { id: string; modelOverride?: { providerId: string; modelId: string } }[],
  models: new Set<string>(),
  runtimeRevision: 0,
}));

vi.mock('../settings/settingsService', () => ({
  settingsService: { get: async () => state.settings },
}));
vi.mock('../thread/threadService', () => ({
  threadService: { listAll: async () => state.threads },
}));
vi.mock('../llm/providerRegistry', () => ({
  getProviderRegistry: () => ({
    get runtimeRevision() { return state.runtimeRevision; },
    modelRuntime: {
      getModel: (p: string, m: string) => (state.models.has(`${p}/${m}`) ? { id: m } : undefined),
    },
  }),
}));

const { pdfTranslation } = await import('./pdfTranslation');

function settings(over: Partial<SettingsFile['llm']> = {}): SettingsFile {
  return {
    llm: {
      defaultProvider: 'anthropic', defaultModel: 'claude-x',
      providers: {}, customProviders: [], ...over,
    },
  } as unknown as SettingsFile;
}

beforeEach(() => {
  state.settings = settings();
  state.threads = [];
  state.models = new Set(['anthropic/claude-x']);
  state.runtimeRevision = 0;
});

describe('pdfTranslation.resolveModel', () => {
  it('解析得出且 registry 认得 → 回 provider/model，并透传当下那一份 runtimeRevision', async () => {
    state.runtimeRevision = 7;   // 不是 0：硬写 0 或漏传都会红在这一行
    expect(await pdfTranslation.resolveModel({ threadId: null }))
      .toEqual({ providerId: 'anthropic', modelId: 'claude-x', runtimeRevision: 7 });
  });

  it('会话有模型覆写 → 钉住的是会话模型（threadId 真的传到了 resolveActive）', async () => {
    state.threads = [{ id: 'thr-1', modelOverride: { providerId: 'openai', modelId: 'gpt-y' } }];
    state.models.add('openai/gpt-y');
    expect(await pdfTranslation.resolveModel({ threadId: 'thr-1' }))
      .toMatchObject({ providerId: 'openai', modelId: 'gpt-y' });
  });

  it('一个 provider 都没配 → ResolveError 转码成 llm.not_configured，真因留在 cause 里', async () => {
    state.settings = settings({ defaultProvider: null });
    const err = await pdfTranslation.resolveModel({ threadId: null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'llm.not_configured' });
    // 转码不许把真因丢了：dispatcher 的日志之外，这是排查「为什么没有可用模型」的唯一线索。
    expect((err as { cause?: Error }).cause).toBeInstanceOf(Error);
    expect((err as { cause?: Error }).cause?.name).toBe('ResolveError');
  });

  it('设置里留着已经不存在的 model id → 前置校验当场抛，不等抽完整份 PDF', async () => {
    state.models = new Set();      // registry 里查无此模型
    await expect(pdfTranslation.resolveModel({ threadId: null }))
      .rejects.toMatchObject({ code: 'llm.not_configured' });
  });
});
