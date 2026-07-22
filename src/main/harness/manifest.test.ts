import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest, deleteManifest, discardCorruptManifest, type SeedManifest } from './manifest';

const M: SeedManifest = { schemaVersion: 1, locale: 'zh', theme: 'vellum', readingFontSize: 'medium', userName: '老张', agentName: 'KyDog' };

describe('manifest', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-mf-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('write → read 往返；文件 0600', async () => {
    await writeManifest(M, dir);
    const r = await readManifest(dir);
    expect(r).toEqual({ status: 'ok', manifest: M });
    if (process.platform !== 'win32') {
      expect(statSync(path.join(dir, '.onboarding-seed.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('不存在 → none', async () => {
    expect(await readManifest(dir)).toEqual({ status: 'none' });
  });

  it('JSON 损坏 / 字段非法 / schemaVersion 不对 → corrupt', async () => {
    const p = path.join(dir, '.onboarding-seed.json');
    writeFileSync(p, '{oops');
    expect((await readManifest(dir)).status).toBe('corrupt');
    writeFileSync(p, JSON.stringify({ ...M, theme: 'neon' }));
    expect((await readManifest(dir)).status).toBe('corrupt');
    writeFileSync(p, JSON.stringify({ ...M, schemaVersion: 2 }));
    expect((await readManifest(dir)).status).toBe('corrupt');
    writeFileSync(p, JSON.stringify({ ...M, userName: 'a\nb' }));
    expect((await readManifest(dir)).status).toBe('corrupt');
    writeFileSync(p, JSON.stringify({ ...M, locale: 'fr' }));
    expect((await readManifest(dir)).status).toBe('corrupt');
  });

  it('discardCorruptManifest 改名 .bad 留证', async () => {
    const p = path.join(dir, '.onboarding-seed.json');
    writeFileSync(p, '{oops');
    await discardCorruptManifest(dir);
    expect(existsSync(p)).toBe(false);
    expect(readFileSync(p + '.bad', 'utf8')).toBe('{oops');
  });

  it('deleteManifest best-effort（不存在不抛）', async () => {
    await expect(deleteManifest(dir)).resolves.toBeUndefined();
  });
});
