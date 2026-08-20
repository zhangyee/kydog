// src/main/persist/atomicWrite.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite, atomicWriteBytes } from './atomicWrite';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('atomicWriteBytes', () => {
  it('原样写出二进制，不经 utf8 编码', async () => {
    const target = path.join(dir, 'a.png');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    await atomicWriteBytes(target, bytes);
    expect([...(await fs.readFile(target))]).toEqual([...bytes]);
  });

  it('目标是符号链接时换掉链接本身，不写穿到链接目标', async () => {
    const outside = path.join(dir, 'outside.png');
    await fs.writeFile(outside, 'ORIGINAL');
    const target = path.join(dir, 'link.png');
    await fs.symlink(outside, target);
    await atomicWriteBytes(target, new Uint8Array([1, 2, 3]));
    expect(await fs.readFile(outside, 'utf8')).toBe('ORIGINAL');
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
  });

  it('写失败不留 tmp 残渣', async () => {
    const target = path.join(dir, 'sub', 'a.png');
    // 目标目录名被一个普通文件占了 → mkdir 失败，直接抛，目录里不该多出东西
    await fs.writeFile(path.join(dir, 'sub'), 'x');
    await expect(atomicWriteBytes(target, new Uint8Array([1]))).rejects.toThrow();
    expect((await fs.readdir(dir)).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});

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

import { promises as fsp, statSync, mkdtempSync, rmSync } from 'node:fs';
import { atomicWriteWith0600Async, atomicWriteWith0600Sync } from './atomicWrite';

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

  it.skipIf(skip)('sync 版本同等行为', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-atomic-sync-'));
    const target = path.join(dir, 'a.json');
    atomicWriteWith0600Sync(target, '{"sync":true}');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true });
  });
});
