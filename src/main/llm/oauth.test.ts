import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AuthInteraction, Credential } from '@earendil-works/pi-ai';

// 只观察 oauth.ts 的映射层：pi 的 AuthPrompt → oauth.prompt 广播 → 渲染进程的答案 → pi。
// 中间的 registry / settings / agent 都不参与这条信号，直接替身掉。
const emitted = vi.hoisted(() => [] as Array<{ topic: string; payload: Record<string, unknown> }>);
vi.mock('../ipc/broadcaster', () => ({
  broadcaster: {
    emit: (topic: string, payload: Record<string, unknown>) => { emitted.push({ topic, payload }); },
  },
}));

const fakeRuntime = vi.hoisted(() => ({ login: vi.fn(), logout: vi.fn() }));
vi.mock('./providerRegistry', () => ({
  getProviderRegistry: () => ({ modelRuntime: fakeRuntime, refreshAfterProviderChange: async () => {} }),
}));
vi.mock('../settings/settingsService', () => ({ settingsService: {} }));
vi.mock('../agent/AgentService', () => ({ agentService: {} }));
vi.mock('electron', () => ({ shell: { openExternal: async () => {} } }));

import { oauthCoordinator } from './oauth';

const CREDENTIAL = { type: 'oauth', access: 'a', refresh: 'r', expires: 0 } as Credential;

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('等广播超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function lastPrompt(): { providerId: string; prompt: Record<string, unknown> } {
  const e = [...emitted].reverse().find((x) => x.topic === 'oauth.prompt');
  if (!e) throw new Error('没有 oauth.prompt 广播');
  return e.payload as unknown as { providerId: string; prompt: Record<string, unknown> };
}

/** 跑一次登录：pi 侧由 piFlow 扮演，渲染进程侧由 answer 扮演。返回 pi 收到的答案。 */
async function runLogin(
  piFlow: (interaction: AuthInteraction) => Promise<unknown>,
  answer: (payload: ReturnType<typeof lastPrompt>) => string,
): Promise<void> {
  fakeRuntime.login.mockImplementation(async (_id: string, _type: string, interaction: AuthInteraction) => {
    await piFlow(interaction);
    return CREDENTIAL;
  });
  const done = oauthCoordinator.login('openai-codex');
  await waitFor(() => emitted.some((e) => e.topic === 'oauth.prompt'));
  oauthCoordinator.promptReply('openai-codex', answer(lastPrompt()));
  await done;
}

describe('oauthCoordinator 的 prompt 映射', () => {
  beforeEach(() => {
    emitted.length = 0;
    fakeRuntime.login.mockReset();
  });

  it('select：选项 id 与 label 原样广播，选中的 id 原样回到 pi', async () => {
    let received: string | undefined;
    await runLogin(
      async (interaction) => {
        // 与 pi openai-codex.js 里那次 prompt 一模一样。
        received = await interaction.prompt({
          type: 'select',
          message: 'Select OpenAI Codex login method:',
          options: [
            { id: 'browser', label: 'Browser login (default)' },
            { id: 'device_code', label: 'Device code login (headless)' },
          ],
        });
      },
      () => 'device_code',
    );

    const { providerId, prompt } = lastPrompt();
    expect(providerId).toBe('openai-codex');
    expect(prompt.type).toBe('select');
    expect(prompt.message).toBe('Select OpenAI Codex login method:');
    const options = prompt.options as Array<{ id: string; label: string }>;
    // id 是要回传给 pi 的答案，label 是 provider 的措辞：两样都不许丢、不许改写。
    expect(options.map((o) => o.id)).toEqual(['browser', 'device_code']);
    expect(options.map((o) => o.label)).toEqual(['Browser login (default)', 'Device code login (headless)']);

    expect(received).toBe('device_code');
    expect(fakeRuntime.login).toHaveBeenCalledWith('openai-codex', 'oauth', expect.anything());
    expect(emitted.some((e) => e.topic === 'oauth.success')).toBe(true);
  });

  it('select：option 的 description 也带过去', async () => {
    await runLogin(
      async (interaction) => {
        await interaction.prompt({
          type: 'select',
          message: 'pick',
          options: [{ id: 'a', label: 'A', description: '带说明的选项' }],
        });
      },
      () => 'a',
    );
    const options = lastPrompt().prompt.options as Array<{ description?: string }>;
    expect(options[0].description).toBe('带说明的选项');
  });

  it('manual_code：仍然覆盖成中文提示（这是类型译名，不含 provider 内容）', async () => {
    let received: string | undefined;
    await runLogin(
      async (interaction) => {
        received = await interaction.prompt({ type: 'manual_code', message: 'Paste the callback code' });
      },
      () => 'code-123',
    );
    const { prompt } = lastPrompt();
    expect(prompt.type).toBe('manual_code');
    expect(prompt.message).toBe('请粘贴回调码');
    expect(received).toBe('code-123');
  });

  it('text：message 与 placeholder 原样带过去', async () => {
    await runLogin(
      async (interaction) => {
        await interaction.prompt({ type: 'text', message: 'Enter your tenant', placeholder: 'acme' });
      },
      () => 'acme-corp',
    );
    const { prompt } = lastPrompt();
    expect(prompt.type).toBe('text');
    expect(prompt.message).toBe('Enter your tenant');
    expect(prompt.placeholder).toBe('acme');
  });

  // pi 的 AuthPrompt.signal 是 per-prompt 取消，跟整条登录的 interaction.signal 不是一回事：
  // openai-codex / anthropic / openrouter 都在 finally 里 `manualAbort.abort()`，用来撤掉
  // 浏览器回调已经赢下之后还挂着的粘贴框。
  it('per-prompt abort：广播 promptCancel，prompt 以 reject 收场，登录照样成功', async () => {
    const manualAbort = new AbortController();
    let manualPromise: Promise<void> | undefined;
    let rejected: unknown;
    fakeRuntime.login.mockImplementation(async (_id: string, _type: string, interaction: AuthInteraction) => {
      manualPromise = interaction
        .prompt({ type: 'manual_code', message: 'paste the code', signal: manualAbort.signal })
        .then(() => {})
        .catch((e: unknown) => { rejected = e; });
      await waitFor(() => emitted.some((e) => e.topic === 'oauth.prompt'));
      // 本地回调服务器先拿到 code，pi 在 finally 里撤掉粘贴框。
      manualAbort.abort();
      return CREDENTIAL;
    });

    await oauthCoordinator.login('openai-codex');
    await manualPromise;

    const cancels = emitted.filter((e) => e.topic === 'oauth.promptCancel');
    expect(cancels.map((e) => e.payload.providerId)).toEqual(['openai-codex']);
    expect(rejected).toBeInstanceOf(Error);
    // 契约是 reject 而不是 resolve('')：空串会被 pi 当成用户真粘了个空值。
    expect(emitted.some((e) => e.topic === 'oauth.success')).toBe(true);
    expect(emitted.some((e) => e.topic === 'oauth.error')).toBe(false);
  });

  it('per-prompt abort 之后迟到的 promptReply：喂不进已死的 prompt', async () => {
    const manualAbort = new AbortController();
    const settled: string[] = [];
    fakeRuntime.login.mockImplementation(async (_id: string, _type: string, interaction: AuthInteraction) => {
      const manual = interaction
        .prompt({ type: 'manual_code', message: 'paste the code', signal: manualAbort.signal })
        .then((v: string) => { settled.push(`resolve:${v}`); })
        .catch(() => { settled.push('reject'); });
      await waitFor(() => emitted.some((e) => e.topic === 'oauth.prompt'));
      manualAbort.abort();
      await manual;
      // 渲染进程慢半拍才把用户粘的码送回来。
      oauthCoordinator.promptReply('openai-codex', 'late-code');
      await new Promise((r) => setTimeout(r, 10));
      return CREDENTIAL;
    });

    await oauthCoordinator.login('openai-codex');
    expect(settled).toEqual(['reject']);
  });

  it('迟到的 abort 不误伤下一个 prompt：只放空自己挂上去的 resolver', async () => {
    const staleAbort = new AbortController();
    let second: string | undefined;
    fakeRuntime.login.mockImplementation(async (_id: string, _type: string, interaction: AuthInteraction) => {
      const first = interaction
        .prompt({ type: 'manual_code', message: 'paste the code', signal: staleAbort.signal })
        .catch(() => {});
      await waitFor(() => emitted.some((e) => e.topic === 'oauth.prompt'));
      // 第一个问题还挂着，pi 就问了第二个（第二个没有 per-prompt signal）。
      const secondPromise = interaction.prompt({ type: 'text', message: 'Enter your tenant' });
      await waitFor(() => emitted.filter((e) => e.topic === 'oauth.prompt').length === 2);
      // 这时候第一个问题的 signal 才 abort。
      staleAbort.abort();
      await first;
      oauthCoordinator.promptReply('openai-codex', 'acme-corp');
      second = await secondPromise;
      return CREDENTIAL;
    });

    await oauthCoordinator.login('openai-codex');
    expect(second).toBe('acme-corp');
  });

  it('signal 在订阅前就已经 aborted：当场 reject，连 oauth.prompt 都不广播', async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    let rejected: unknown;
    fakeRuntime.login.mockImplementation(async (_id: string, _type: string, interaction: AuthInteraction) => {
      await interaction
        .prompt({ type: 'manual_code', message: 'paste the code', signal: preAborted.signal })
        .catch((e: unknown) => { rejected = e; });
      return CREDENTIAL;
    });

    await oauthCoordinator.login('openai-codex');
    expect(rejected).toBeInstanceOf(Error);
    expect(emitted.some((e) => e.topic === 'oauth.prompt')).toBe(false);
  });

  it('正常答完的 prompt：照常 resolve，pi 事后 abort 也不再广播 promptCancel', async () => {
    const manualAbort = new AbortController();
    let received: string | undefined;
    fakeRuntime.login.mockImplementation(async (_id: string, _type: string, interaction: AuthInteraction) => {
      const manual = interaction.prompt({ type: 'manual_code', message: 'paste the code', signal: manualAbort.signal });
      await waitFor(() => emitted.some((e) => e.topic === 'oauth.prompt'));
      oauthCoordinator.promptReply('openai-codex', 'code-123');
      received = await manual;
      // pi 的 finally 照样会 abort 一次：监听器该已经摘掉了。
      manualAbort.abort();
      return CREDENTIAL;
    });

    await oauthCoordinator.login('openai-codex');
    expect(received).toBe('code-123');
    expect(emitted.some((e) => e.topic === 'oauth.promptCancel')).toBe(false);
    expect(emitted.some((e) => e.topic === 'oauth.success')).toBe(true);
  });

  it('select 期间取消：resolver 被放空，登录以 error 收场而不是挂住', async () => {
    fakeRuntime.login.mockImplementation(async (_id: string, _type: string, interaction: AuthInteraction) => {
      const method = await interaction.prompt({
        type: 'select',
        message: 'Select OpenAI Codex login method:',
        options: [{ id: 'browser', label: 'Browser login (default)' }],
      });
      // pi 对无法识别的答案就是这么处理的（openai-codex.js）。
      if (method !== 'browser') throw new Error(`Unknown OpenAI Codex login method: ${method}`);
      return CREDENTIAL;
    });

    const done = oauthCoordinator.login('openai-codex');
    await waitFor(() => emitted.some((e) => e.topic === 'oauth.prompt'));
    oauthCoordinator.cancel('openai-codex');

    await expect(done).rejects.toThrow(/Unknown OpenAI Codex login method/);
    expect(emitted.some((e) => e.topic === 'oauth.error')).toBe(true);
  });
});
