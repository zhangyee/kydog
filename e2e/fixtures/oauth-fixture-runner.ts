import { promises as fsp } from 'node:fs';
import type { AuthPrompt } from '@earendil-works/pi-ai';
import type { OAuthFixture } from './oauth-mock';

interface FixtureInteraction {
  notify: (event: { type: string; [k: string]: unknown }) => void;
  // 用 pi 的 AuthPrompt：fixture 分支和真实分支喂给 oauth.ts 的形状必须一致，
  // 否则 fixture 走得通、真登录仍然是坏的（这次的 bug 正是这么漏过去的）。
  prompt: (p: AuthPrompt) => Promise<string>;
}

export async function runFixtureFlow(
  _providerId: string,
  fixturePath: string,
  interaction: FixtureInteraction,
): Promise<void> {
  const raw = await fsp.readFile(fixturePath, 'utf8');
  const f: OAuthFixture = JSON.parse(raw);
  const start = Date.now();
  // select 先于 auth_url，与 pi 的 openai-codex 流程一致。
  if (f.selectBeforeAuth) {
    await interaction.prompt({
      type: 'select',
      message: f.selectBeforeAuth.message,
      options: f.selectBeforeAuth.options,
    });
  }
  await new Promise((r) => setTimeout(r, Math.max(0, f.onAuthAfterMs - (Date.now() - start))));
  interaction.notify({ type: 'auth_url', url: f.url });
  for (const p of f.progressMessages ?? []) {
    await new Promise((r) => setTimeout(r, Math.max(0, p.afterMs - (Date.now() - start))));
    interaction.notify({ type: 'progress', message: p.text });
  }
  if (f.expectsManualCode) {
    await interaction.prompt({ type: 'manual_code', message: 'fixture: paste code' });
  }
  await new Promise((r) => setTimeout(r, Math.max(0, f.successAfterMs - (Date.now() - start))));
}
