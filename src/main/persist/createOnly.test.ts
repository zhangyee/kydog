import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createOnly } from './createOnly';

it('atomically commits one fully written contender, preserves collisions, and removes its own temporary files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-create-'));
  try {
    const target = path.join(dir, 'report.md');
    const a = 'a'.repeat(200_000),
      b = '中'.repeat(200_000);
    const results = await Promise.allSettled([
      createOnly(target, a),
      createOnly(target, b),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'rejected').map((r) => r.reason.code),
    ).toEqual(['EEXIST']);
    const content = await fs.readFile(target, 'utf8');
    expect([a, b]).toContain(content);
    await expect(createOnly(target, 'replacement')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await fs.readFile(target, 'utf8')).toBe(content);
    expect(await fs.readdir(dir)).toEqual(['report.md']);
    await fs.mkdir(path.join(dir, 'folder'));
    await expect(
      createOnly(path.join(dir, 'folder'), 'x'),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await fs.stat(path.join(dir, 'folder'))).isDirectory()).toBe(true);
    expect((await fs.readdir(dir)).sort()).toEqual(['folder', 'report.md']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

import {
  SKIP_WITHOUT_SYMLINK,
  SYMLINK_SKIP_REASON,
} from '../../test-support/symlinkCapability';
it.skipIf(SKIP_WITHOUT_SYMLINK)(
  `does not replace or follow an existing destination symlink (${SYMLINK_SKIP_REASON})`,
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-create-link-'));
    try {
      const original = path.join(dir, 'original'),
        link = path.join(dir, 'link');
      await createOnly(original, 'original content');
      expect(await fs.readFile(original, 'utf8')).toBe('original content');
      await fs.symlink(original, link);
      await expect(createOnly(link, 'replacement')).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(await fs.readFile(original, 'utf8')).toBe('original content');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect((await fs.readdir(dir)).sort()).toEqual(['link', 'original']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
