// src/main/persist/atomicWrite.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite, atomicWriteBytes, renameWithRetry } from './atomicWrite';

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

  it.skipIf(SKIP_WITHOUT_SYMLINK)('目标是符号链接时换掉链接本身，不写穿到链接目标', async () => {
    const outside = path.join(dir, 'outside.png');
    await fs.writeFile(outside, 'ORIGINAL');
    const target = path.join(dir, 'link.png');
    await fs.symlink(outside, target);
    await atomicWriteBytes(target, new Uint8Array([1, 2, 3]));
    expect(await fs.readFile(outside, 'utf8')).toBe('ORIGINAL');
    expect((await fs.lstat(target)).isSymbolicLink()).toBe(false);
  });

  it('rename 失败时清掉 tmp 残渣', async () => {
    // 失败必须发生在 try 内部才走得到清理路径：mkdir 在 try 外面，那时 tmp 还没建。
    // 让 target 是一个已存在的目录 → tmp 写得出来，rename 到目录上必失败。
    const target = path.join(dir, 'occupied');
    await fs.mkdir(target);
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
import { SKIP_WITHOUT_SYMLINK } from '../../test-support/symlinkCapability';

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

describe('renameWithRetry', () => {
  const errno = (code: string) => Object.assign(new Error(code), { code });
  /** rename 的替身：前 n 次抛 code，之后成功；记下调用次数与每次等了多久。 */
  function flaky(code: string, failures: number) {
    const calls: string[] = [];
    const waits: number[] = [];
    let left = failures;
    return {
      calls, waits,
      rename: async () => { calls.push('rename'); if (left-- > 0) throw errno(code); },
      sleep: async (ms: number) => { waits.push(ms); },
    };
  }

  it('Windows 上 EPERM / EACCES / EBUSY 是短暂锁：退避重试到成功', async () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
      const f = flaky(code, 2);
      await renameWithRetry('a', 'b', { platform: 'win32', rename: f.rename, sleep: f.sleep });
      expect(f.calls, code).toHaveLength(3);
      expect(f.waits, code).toEqual([10, 25]);
    }
  });

  it('同样的错误在非 Windows 上不重试，当场抛（正向对照：上一条同一个替身在 win32 上会重试）', async () => {
    const f = flaky('EPERM', 1);
    await expect(renameWithRetry('a', 'b', { platform: 'darwin', rename: f.rename, sleep: f.sleep }))
      .rejects.toMatchObject({ code: 'EPERM' });
    expect(f.calls).toHaveLength(1);
    expect(f.waits).toEqual([]);
  });

  it('不认的 errno 在 Windows 上也不重试（ENOENT 这类不是锁）', async () => {
    const f = flaky('ENOENT', 1);
    await expect(renameWithRetry('a', 'b', { platform: 'win32', rename: f.rename, sleep: f.sleep }))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.calls).toHaveLength(1);
  });

  it('锁一直不放：退避预算用完就把最后那个错误原样抛出，不无限等', async () => {
    const f = flaky('EBUSY', Infinity);
    await expect(renameWithRetry('a', 'b', { platform: 'win32', rename: f.rename, sleep: f.sleep }))
      .rejects.toMatchObject({ code: 'EBUSY' });
    expect(f.waits).toEqual([10, 25, 50, 100, 200, 400, 800]);
    expect(f.calls).toHaveLength(8);
  });
});
