import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { downloadAndVerify, findFile } from './archive.mjs';

describe('archive', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'bins-archive-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('downloadAndVerify throws on sha mismatch', async () => {
    const body = 'hello';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const dest = path.join(dir, 'a.bin');
    await expect(downloadAndVerify('https://x/a.bin', 'badsha', dest)).rejects.toThrow(/sha256 mismatch/i);
  });

  it('downloadAndVerify writes file on sha match', async () => {
    const body = 'hello';
    const sha = createHash('sha256').update(body).digest('hex');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const dest = path.join(dir, 'a.bin');
    await downloadAndVerify('https://x/a.bin', sha, dest);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(dest, 'utf-8')).toBe(body);
  });

  it('findFile locates a nested file by exact name', () => {
    const sub = path.join(dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, 'fastpaper'), 'bin');
    expect(findFile(dir, 'fastpaper')).toBe(path.join(sub, 'fastpaper'));
  });

  it('findFile returns null when no match', () => {
    writeFileSync(path.join(dir, 'other'), 'x');
    expect(findFile(dir, 'fastpaper')).toBeNull();
  });
});
