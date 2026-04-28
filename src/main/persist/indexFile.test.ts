// src/main/persist/indexFile.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as paths from './paths';
import { loadIndex, saveIndex, defaultIndex } from './indexFile';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-'));
  vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('indexFile', () => {
  it('returns default when missing', async () => {
    expect(await loadIndex()).toEqual(defaultIndex());
  });
  it('round-trips', async () => {
    const v = { schemaVersion: 1 as const, projects: [{ path: '/p', addedAt: 't' }], threads: [] };
    await saveIndex(v);
    expect(await loadIndex()).toEqual(v);
  });
  it('returns default on corrupted JSON', async () => {
    await fs.writeFile(path.join(dir, 'index.json'), 'not json');
    expect(await loadIndex()).toEqual(defaultIndex());
  });
});
