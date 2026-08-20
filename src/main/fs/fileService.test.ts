import { describe, it, expect } from 'vitest';
import { promises as fs, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileService } from './fileService';

describe('fileService', () => {
  it('readText 返回文件内容', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-'));
    const f = path.join(dir, 'a.md');
    await fs.writeFile(f, '# hello');
    expect(await fileService.readText({ path: f })).toEqual({ content: '# hello' });
  });

  it('readText 文件不存在抛 fs.read_failed', async () => {
    await expect(fileService.readText({ path: '/nonexistent/x.md' }))
      .rejects.toMatchObject({ code: 'fs.read_failed' });
  });

  it('readText 超过 2MB 抛 fs.too_large', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-'));
    const f = path.join(dir, 'big.md');
    await fs.writeFile(f, 'x'.repeat(2 * 1024 * 1024 + 1));
    await expect(fileService.readText({ path: f }))
      .rejects.toMatchObject({ code: 'fs.too_large' });
  });

  it('readText 传目录路径抛 fs.read_failed', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-'));
    await expect(fileService.readText({ path: dir }))
      .rejects.toMatchObject({ code: 'fs.read_failed' });
  });

  it('writeText 后 readText 往返一致', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-'));
    const f = path.join(dir, 'w.md');
    await fileService.writeText({ path: f, content: '# written' });
    expect(await fileService.readText({ path: f })).toEqual({ content: '# written' });
  });

  it('readBytes 返回文件字节', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-'));
    const f = path.join(dir, 'a.pdf');
    await fs.writeFile(f, Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const { bytes } = await fileService.readBytes({ path: f });
    expect(Array.from(bytes)).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('readBytes 文件不存在抛 fs.read_failed', async () => {
    await expect(fileService.readBytes({ path: '/nonexistent/x.pdf' }))
      .rejects.toMatchObject({ code: 'fs.read_failed' });
  });

  it('readBytes 传目录路径抛 fs.read_failed', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-'));
    await expect(fileService.readBytes({ path: dir }))
      .rejects.toMatchObject({ code: 'fs.read_failed' });
  });

  it('readBytes 超过 100MB 抛 fs.too_large', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-'));
    const f = path.join(dir, 'big.pdf');
    await fs.writeFile(f, '');
    await fs.truncate(f, 100 * 1024 * 1024 + 1); // 稀疏文件，瞬时
    await expect(fileService.readBytes({ path: f }))
      .rejects.toMatchObject({ code: 'fs.too_large' });
  });
});

// readBytesWithin：比 readBytes 多一道 realpath 边界校验，专门堵符号链接逃逸——
// 字符串层面的路径校验（reportTheme.ts 的 resolveInlineTarget）拦不住「文件名在
// 白名单里、字符串路径看着在目录树内，实际是个指向树外的符号链接」这种向量。
describe('fileService.readBytesWithin', () => {
  it('树内普通文件 → 通过', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-base-'));
    const target = path.join(base, 'figs', 'a.png');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from([1, 2, 3]));
    const { bytes } = await fileService.readBytesWithin({ baseDir: base, path: target });
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('树内符号链接指向树外 → 拒绝', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-base-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-outside-'));
    const secret = path.join(outside, 'secret.png');
    await fs.writeFile(secret, Buffer.from([9, 9, 9]));
    const link = path.join(base, 'a.png'); // 文件名带白名单扩展名，字符串上看着在 base 里
    await fs.symlink(secret, link);
    await expect(fileService.readBytesWithin({ baseDir: base, path: link }))
      .rejects.toMatchObject({ code: 'fs.access_denied' });
  });

  it('baseDir 自己是符号链接、目标文件在其真实位置内 → 通过（两边都 realpath 了才对）', async () => {
    const realBase = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-real-'));
    const target = path.join(realBase, 'a.png');
    await fs.writeFile(target, Buffer.from([4, 5, 6]));
    const linkBaseParent = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-linkparent-'));
    const linkBase = path.join(linkBaseParent, 'proj-link'); // baseDir 参数本身是个符号链接
    await fs.symlink(realBase, linkBase, 'dir');
    const linkTarget = path.join(linkBase, 'a.png'); // 经过符号链接目录访问同一个文件
    const { bytes } = await fileService.readBytesWithin({ baseDir: linkBase, path: linkTarget });
    expect(Array.from(bytes)).toEqual([4, 5, 6]);
  });

  it('前缀撞名但不在目录树内 → 拒绝（不能只用 startsWith，要按路径分隔符边界比较）', async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-parent-'));
    const base = path.join(parent, 'proj');
    const evil = path.join(parent, 'proj-evil'); // 字符串前缀能匹配上 base，但不是子目录
    await fs.mkdir(base, { recursive: true });
    await fs.mkdir(evil, { recursive: true });
    const target = path.join(evil, 'x.png');
    await fs.writeFile(target, Buffer.from([7]));
    await expect(fileService.readBytesWithin({ baseDir: base, path: target }))
      .rejects.toMatchObject({ code: 'fs.access_denied' });
  });

  it('路径不存在 → 干净报错（fs.read_failed），不崩', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-base-'));
    await expect(fileService.readBytesWithin({ baseDir: base, path: path.join(base, 'nope.png') }))
      .rejects.toMatchObject({ code: 'fs.read_failed' });
  });

  it('baseDir 自己不存在 → 干净报错（fs.read_failed），不崩', async () => {
    const base = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-base-'));
    const target = path.join(base, 'a.png');
    await fs.writeFile(target, Buffer.from([1]));
    await expect(fileService.readBytesWithin({ baseDir: path.join(base, 'nonexistent-sub'), path: target }))
      .rejects.toMatchObject({ code: 'fs.read_failed' });
  });
});
