// src/main/persist/atomicWrite.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite } from './atomicWrite';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('atomicWrite', () => {
  it('writes the file', async () => {
    const target = path.join(dir, 'a.json');
    await atomicWrite(target, '{"x":1}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"x":1}');
  });
  it('overwrites existing content', async () => {
    const target = path.join(dir, 'a.json');
    await fs.writeFile(target, 'old');
    await atomicWrite(target, 'new');
    expect(await fs.readFile(target, 'utf8')).toBe('new');
  });
  it('does not leave .tmp files on success', async () => {
    const target = path.join(dir, 'a.json');
    await atomicWrite(target, 'x');
    const entries = await fs.readdir(dir);
    expect(entries.filter(e => e.includes('.tmp.'))).toEqual([]);
  });
});

import { promises as fsp, statSync } from 'node:fs';
import { atomicWriteWith0600Async } from './atomicWrite';

describe('atomicWriteWith0600 (POSIX)', () => {
  const skip = process.platform === 'win32';
  it.skipIf(skip)('temp 出生即 0600（不依赖 umask）', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kydog-atomic-'));
    const target = path.join(dir, 'a.json');
    await atomicWriteWith0600Async(target, '{"x":1}');
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
    await fsp.rm(dir, { recursive: true });
  });

  it.skipIf(skip)('rename 后 idempotent chmod 修正异常 mode', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kydog-atomic-'));
    const target = path.join(dir, 'a.json');
    await atomicWriteWith0600Async(target, '{}');
    await fsp.chmod(target, 0o644);            // 模拟外部破坏
    await atomicWriteWith0600Async(target, '{"y":2}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    await fsp.rm(dir, { recursive: true });
  });
});
