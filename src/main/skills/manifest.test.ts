import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest, emptyManifest } from './manifest';

describe('manifest', () => {
  it('returns emptyManifest when file does not exist', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'man-'));
    const m = await readManifest(path.join(dir, 'nope.json'));
    expect(m).toEqual(emptyManifest());
  });

  it('round-trips', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'man-'));
    const f = path.join(dir, 'm.json');
    const m = {
      kydogVersion: '0.2.0',
      writtenAt: '2026-04-30T00:00:00Z',
      builtin: { fastpaper: { kydogVersion: '0.2.0', files: { 'SKILL.md': 'abc' } } },
    };
    await writeManifest(f, m);
    expect(await readManifest(f)).toEqual(m);
  });
});
