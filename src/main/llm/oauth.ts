// src/main/llm/oauth.ts
import { shell } from 'electron';
import { broadcaster } from '../ipc/broadcaster';
import { getProviderRegistry } from './providerRegistry';
import { getCatalogEntry } from './catalog';
import { settingsService } from '../settings/settingsService';
import { agentService } from '../agent/AgentService';
import { logger } from '../log';
import type { ProviderId } from '../../shared/types';
import type { OAuthPromptPayload } from '../../shared/protocol';
// 用 pi 自己的 AuthPrompt 钉住形状：pi 哪天加一个 prompt 变体，这里编译期就会报错。
import type { AuthPrompt } from '@earendil-works/pi-ai';

type Pending = {
  controller: AbortController;
  promptResolver?: (value: string) => void;
};

class OAuthCoordinator {
  private inflight = new Map<ProviderId, Pending>();

  async login(providerId: ProviderId): Promise<void> {
    const cat = getCatalogEntry(providerId);
    if (!cat || cat.kind !== 'oauth' || !cat.oauth) {
      throw new Error(`provider ${providerId} is not an OAuth provider`);
    }
    if (this.inflight.has(providerId)) {
      throw new Error(`oauth login already in flight for ${providerId}`);
    }
    const reg = getProviderRegistry();
    const controller = new AbortController();
    this.inflight.set(providerId, { controller });

    // 等一个渲染进程回填的输入：把 resolver 挂到 inflight 上，再把提示广播出去。
    const askRenderer = (prompt: OAuthPromptPayload) =>
      new Promise<string>((resolve) => {
        const pending = this.inflight.get(providerId);
        if (!pending) return resolve('');
        pending.promptResolver = resolve;
        broadcaster.emit('oauth.prompt', { providerId, prompt });
      });

    const interaction = {
      signal: controller.signal,
      notify: (event: { type: string; [k: string]: unknown }) => {
        if (event.type === 'auth_url') {
          const url = typeof event.url === 'string' ? event.url : '';
          const instructions = typeof event.instructions === 'string' ? event.instructions : undefined;
          broadcaster.emit('oauth.auth', { providerId, url, instructions });
          // Fixture mode (e2e)：URL 是假的 example.test 地址，别去开用户的浏览器。
          if (process.env.KYDOG_OAUTH_FIXTURE || !url) return;
          void shell.openExternal(url).catch((err) => logger.warn('oauth', 'shell.openExternal failed', { err: String(err) }));
          return;
        }
        if (event.type === 'progress' || event.type === 'info') {
          broadcaster.emit('oauth.progress', { providerId, message: String(event.message ?? '') });
          return;
        }
        if (event.type === 'device_code') {
          // device_code 只是信息，KyDog 没有专门的 UI，退化到进度通道而不是报错。
          const userCode = typeof event.userCode === 'string' ? event.userCode : '';
          const verificationUri = typeof event.verificationUri === 'string' ? event.verificationUri : '';
          broadcaster.emit('oauth.progress', { providerId, message: `在 ${verificationUri} 输入代码 ${userCode}` });
          return;
        }
        // 未知的新 event 变体：忽略。通知类事件不该让一次登录崩掉。
      },
      prompt: (p: AuthPrompt) => {
        // select 的 message / label 是 provider 自己的内容，逐字带过去，不翻译也不改写：
        // 想翻译就得按 provider 维护一张英文串→中文的表，pi 改一次措辞或多给一个选项，
        // 那张表就会静默失真甚至张冠李戴。中文外框由渲染进程给（它知道这是「选择登录方式」，
        // 与 provider 无关），选项本身照抄。id 尤其要原样回传——pi 拿它分支。
        if (p.type === 'select') {
          return askRenderer({
            type: 'select',
            message: p.message,
            options: p.options.map((o) => ({ id: o.id, label: o.label, description: o.description })),
          });
        }
        // manual_code 沿用原来的中文提示：这是「回调码」这个类型本身的译名，与 provider 无关，
        // 不像 select 的选项那样承载 provider 特有内容，所以覆盖是安全的。
        if (p.type === 'manual_code') return askRenderer({ type: 'manual_code', message: '请粘贴回调码' });
        return askRenderer({ type: p.type, message: p.message, placeholder: p.placeholder });
      },
    };

    try {
      const fixturePath = process.env.KYDOG_OAUTH_FIXTURE;
      if (fixturePath) {
        const { runFixtureFlow } = await import('../../../e2e/fixtures/oauth-fixture-runner');
        await runFixtureFlow(providerId, fixturePath, interaction);
      } else {
        await reg.modelRuntime.login(cat.oauth.piProviderId, 'oauth', interaction);
      }
      await reg.refreshAfterProviderChange(settingsService, agentService, [providerId]);
      broadcaster.emit('oauth.success', { providerId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcaster.emit('oauth.error', { providerId, error: msg });
      throw err;
    } finally {
      this.inflight.delete(providerId);
    }
  }

  cancel(providerId: ProviderId): void {
    const p = this.inflight.get(providerId);
    if (!p) return;
    p.controller.abort();
    if (p.promptResolver) p.promptResolver('');
  }

  promptReply(providerId: ProviderId, value: string): void {
    const p = this.inflight.get(providerId);
    if (p?.promptResolver) {
      p.promptResolver(value);
      p.promptResolver = undefined;
    }
  }

  async logout(providerId: ProviderId): Promise<void> {
    const reg = getProviderRegistry();
    await reg.modelRuntime.logout(providerId);
    await reg.refreshAfterProviderChange(settingsService, agentService, [providerId]);
  }
}

export const oauthCoordinator = new OAuthCoordinator();
