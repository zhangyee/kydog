import { promises as fsp } from 'node:fs';
import type { OAuthFixture } from './oauth-mock';

interface FixtureCallbacks {
  onAuth: (a: { url: string; instructions?: string }) => void;
  onProgress: (msg: string) => void;
  onPrompt?: (p: { message: string }) => Promise<string>;
}

export async function runFixtureFlow(
  _providerId: string,
  fixturePath: string,
  callbacks: FixtureCallbacks,
): Promise<void> {
  const raw = await fsp.readFile(fixturePath, 'utf8');
  const f: OAuthFixture = JSON.parse(raw);
  const start = Date.now();
  await new Promise((r) => setTimeout(r, f.onAuthAfterMs));
  callbacks.onAuth({ url: f.url });
  for (const p of f.progressMessages ?? []) {
    await new Promise((r) => setTimeout(r, Math.max(0, p.afterMs - (Date.now() - start))));
    callbacks.onProgress(p.text);
  }
  if (f.expectsManualCode && callbacks.onPrompt) {
    await callbacks.onPrompt({ message: 'fixture: paste code' });
  }
  await new Promise((r) => setTimeout(r, Math.max(0, f.successAfterMs - (Date.now() - start))));
}
