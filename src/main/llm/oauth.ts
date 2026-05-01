// src/main/llm/oauth.ts
import { shell } from 'electron';
import { broadcaster } from '../ipc/broadcaster';
import { getProviderRegistry } from './providerRegistry';
import { getCatalogEntry } from './catalog';
import { settingsService } from '../settings/settingsService';
import { agentService } from '../agent/AgentService';
import { logger } from '../log';
import type { ProviderId } from '../../shared/types';

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

    const callbacks = {
      onAuth: ({ url, instructions }: { url: string; instructions?: string }) => {
        broadcaster.emit('oauth.auth', { providerId, url, instructions });
        void shell.openExternal(url).catch((err) => logger.warn('oauth', 'shell.openExternal failed', { err: String(err) }));
      },
      onProgress: (message: string) => broadcaster.emit('oauth.progress', { providerId, message }),
      onPrompt: (prompt: { message: string; placeholder?: string; allowEmpty?: boolean }) =>
        new Promise<string>((resolve) => {
          const pending = this.inflight.get(providerId);
          if (!pending) return resolve('');
          pending.promptResolver = resolve;
          broadcaster.emit('oauth.prompt', { providerId, prompt });
        }),
      onManualCodeInput: () =>
        new Promise<string>((resolve) => {
          const pending = this.inflight.get(providerId);
          if (!pending) return resolve('');
          pending.promptResolver = resolve;
          broadcaster.emit('oauth.prompt', { providerId, prompt: { message: '请粘贴回调码' } });
        }),
      signal: controller.signal,
    };

    try {
      const fixturePath = process.env.KYDOG_OAUTH_FIXTURE;
      if (fixturePath) {
        const { runFixtureFlow } = await import('../../../e2e/fixtures/oauth-fixture-runner');
        await runFixtureFlow(providerId, fixturePath, callbacks);
      } else {
        await (reg.authStorage as any).login(cat.oauth.piProviderId, callbacks);
      }
      reg.reloadAuth();
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
    (reg.authStorage as any).logout(providerId);
    reg.reloadAuth();
    await reg.refreshAfterProviderChange(settingsService, agentService, [providerId]);
  }
}

export const oauthCoordinator = new OAuthCoordinator();
