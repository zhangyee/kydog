import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { discoverExecutable, downloadAndVerify } from './archive.mjs';

describe('archive', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'bins-archive-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('discoverExecutable picks unique exec-bit file on Unix', () => {
    if (process.platform === 'win32') return;
    writeFileSync(path.join(dir, 'README.md'), 'hi');
    writeFileSync(path.join(dir, 'LICENSE-MIT'), 'hi');
    writeFileSync(path.join(dir, 'fastpaper'), 'fakebin');
    chmodSync(path.join(dir, 'fastpaper'), 0o755);
    expect(discoverExecutable(dir)).toBe('fastpaper');
  });

  it('discoverExecutable picks unique .exe file on Windows', () => {
    if (process.platform !== 'win32') return;
    writeFileSync(path.join(dir, 'README.md'), 'hi');
    writeFileSync(path.join(dir, 'fastpaper.exe'), 'fakebin');
    expect(discoverExecutable(dir)).toBe('fastpaper.exe');
  });

  it('discoverExecutable throws when 0 candidates', () => {
    writeFileSync(path.join(dir, 'README.md'), 'hi');
    expect(() => discoverExecutable(dir)).toThrow(/no executable/i);
  });

  it('discoverExecutable throws when ≥2 candidates', () => {
    if (process.platform === 'win32') {
      writeFileSync(path.join(dir, 'a.exe'), '');
      writeFileSync(path.join(dir, 'b.exe'), '');
    } else {
      writeFileSync(path.join(dir, 'a'), '');
      writeFileSync(path.join(dir, 'b'), '');
      chmodSync(path.join(dir, 'a'), 0o755);
      chmodSync(path.join(dir, 'b'), 0o755);
    }
    expect(() => discoverExecutable(dir)).toThrow(/multiple/i);
  });

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
});
