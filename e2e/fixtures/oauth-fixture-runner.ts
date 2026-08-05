import { promises as fsp } from 'node:fs';
import type { OAuthFixture } from './oauth-mock';

interface FixtureInteraction {
  notify: (event: { type: string; [k: string]: unknown }) => void;
  prompt: (p: { type: string; message: string; placeholder?: string }) => Promise<string>;
}

export async function runFixtureFlow(
  _providerId: string,
  fixturePath: string,
  interaction: FixtureInteraction,
): Promise<void> {
  const raw = await fsp.readFile(fixturePath, 'utf8');
  const f: OAuthFixture = JSON.parse(raw);
  const start = Date.now();
  await new Promise((r) => setTimeout(r, f.onAuthAfterMs));
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
