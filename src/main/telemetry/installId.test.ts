import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { ensureInstallId, readInstallId, dropInstallId } from './installId';

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

describe('readInstallId', () => {
  it('文件不存在时返回 null —— 绝不创建', () => {
    expect(readInstallId()).toBeNull();
    expect(existsSync(path.join(dir, 'install-id'))).toBe(false);
  });

  it('内容损坏时返回 null，且不重新生成', () => {
    writeFileSync(path.join(dir, 'install-id'), 'garbage');
    expect(readInstallId()).toBeNull();
    expect(readFileSync(path.join(dir, 'install-id'), 'utf8')).toBe('garbage');
  });

  it('已有 ID 时原样读出', () => {
    const id = ensureInstallId();
    expect(readInstallId()).toBe(id);
  });

  // 判定用的是契约里那份 UUID_V4_RE（带 /i），不是本地另写的一份。服务端拿同一份
  // 字面量校验：本地多写一个只认小写的版本，就会把一个服务端照收的 ID 判成损坏、
  // 静默换掉 —— 用户看到标识自己变了，服务端那份数据从此没人认领。
  it('大写形式照样认：与契约的 UUID_V4_RE 是同一份判定', () => {
    const id = ensureInstallId();
    const upper = id.toUpperCase();
    expect(upper).not.toBe(id);
    writeFileSync(path.join(dir, 'install-id'), upper);
    expect(readInstallId()).toBe(upper);
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
