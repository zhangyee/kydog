import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureInstallId, dropInstallId } from './installId';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kydog-iid-'));
  vi.spyOn(paths, 'INSTALL_ID_FILE', 'get').mockReturnValue(path.join(dir, 'install-id'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('ensureInstallId', () => {
  it('首次调用生成 UUID v4', () => {
    expect(ensureInstallId()).toMatch(UUID_V4);
  });

  it('幂等：第二次返回同一个值', () => {
    expect(ensureInstallId()).toBe(ensureInstallId());
  });

  const skip = process.platform === 'win32';
  it.skipIf(skip)('文件权限为 0600', () => {
    ensureInstallId();
    const mode = statSync(path.join(dir, 'install-id')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('内容里不含任何机器特征，只有那个 UUID', () => {
    const id = ensureInstallId();
    expect(readFileSync(path.join(dir, 'install-id'), 'utf8')).toBe(id);
  });

  it('两个不同目录得到不同 ID —— 不从机器派生', () => {
    const idA = ensureInstallId();

    const other = mkdtempSync(path.join(tmpdir(), 'kydog-iid-'));
    try {
      vi.spyOn(paths, 'INSTALL_ID_FILE', 'get').mockReturnValue(path.join(other, 'install-id'));
      const idB = ensureInstallId();
      expect(idA).not.toBe(idB);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('文件内容损坏时重新生成', () => {
    ensureInstallId();
    writeFileSync(path.join(dir, 'install-id'), 'garbage');
    expect(ensureInstallId()).toMatch(UUID_V4);
  });
});

describe('dropInstallId', () => {
  it('删除后文件消失', () => {
    ensureInstallId();
    dropInstallId();
    expect(existsSync(path.join(dir, 'install-id'))).toBe(false);
  });

  it('文件不存在时不抛', () => {
    expect(() => dropInstallId()).not.toThrow();
  });
});
