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

  it('writeText 后 readText 往返一致', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-fs-'));
    const f = path.join(dir, 'w.md');
    await fileService.writeText({ path: f, content: '# written' });
    expect(await fileService.readText({ path: f })).toEqual({ content: '# written' });
  });
});
