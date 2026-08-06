import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest, deleteManifest, discardCorruptManifest, type SeedManifest } from './manifest';
import * as paths from '../persist/paths';

const SEED_FILE = path.basename(paths.SEED_MANIFEST_FILE);

const M: SeedManifest = { schemaVersion: 2, locale: 'zh', theme: 'vellum', readingFontSize: 'medium', userName: '老张', agentName: 'KyDog', telemetryState: 'enabled', decidedAt: '2026-07-22T00:00:00.000Z' };

describe('manifest', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-mf-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('write → read 往返；文件 0600', async () => {
    await writeManifest(M, dir);
    const r = await readManifest(dir);
    expect(r).toEqual({ status: 'ok', manifest: M });
    if (process.platform !== 'win32') {
      expect(statSync(path.join(dir, SEED_FILE)).mode & 0o777).toBe(0o600);
    }
  });

  it('不存在 → none', async () => {
    expect(await readManifest(dir)).toEqual({ status: 'none' });
  });

  it('JSON 损坏 / 字段非法 / schemaVersion 不对 → corrupt', async () => {
    const p = path.join(dir, SEED_FILE);
    writeFileSync(p, '{oops');
    expect((await readManifest(dir)).status).toBe('corrupt');
    writeFileSync(p, JSON.stringify({ ...M, theme: 'neon' }));
    expect((await readManifest(dir)).status).toBe('corrupt');
    writeFileSync(p, JSON.stringify({ ...M, schemaVersion: 3 }));
    expect((await readManifest(dir)).status).toBe('corrupt');
    writeFileSync(p, JSON.stringify({ ...M, userName: 'a\nb' }));
    expect((await readManifest(dir)).status).toBe('corrupt');
    writeFileSync(p, JSON.stringify({ ...M, locale: 'fr' }));
    expect((await readManifest(dir)).status).toBe('corrupt');
  });

  it('discardCorruptManifest 改名 .bad 留证', async () => {
    const p = path.join(dir, SEED_FILE);
    writeFileSync(p, '{oops');
    await discardCorruptManifest(dir);
    expect(existsSync(p)).toBe(false);
    expect(readFileSync(p + '.bad', 'utf8')).toBe('{oops');
  });

  it('deleteManifest best-effort（不存在不抛）', async () => {
    await expect(deleteManifest(dir)).resolves.toBeUndefined();
  });
});

const base = {
  locale: 'zh', theme: 'vellum', readingFontSize: 'medium',
  userName: '张三', agentName: '小狗',
} as const;

describe('manifest v2', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-mf2-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trip 保留 telemetryState 与 decidedAt', async () => {
    const m: SeedManifest = { schemaVersion: 2, ...base, telemetryState: 'enabled', decidedAt: '2026-08-05T10:00:00.000Z' };
    await writeManifest(m, dir);
    expect(await readManifest(dir)).toEqual({ status: 'ok', manifest: m });
  });

  // 旧版本写下的 v1 manifest：用户当时根本没见过统计勾选框，
  // 因此恢复时必须是 undecided，而不是替他选一个。
  it('v1 manifest 被接受，telemetryState 迁移为 undecided', async () => {
    writeFileSync(path.join(dir, SEED_FILE), JSON.stringify({ schemaVersion: 1, ...base }));
    const r = await readManifest(dir);
    expect(r.status).toBe('ok');
    expect((r as { manifest: SeedManifest }).manifest.telemetryState).toBe('undecided');
    expect((r as { manifest: SeedManifest }).manifest.decidedAt).toBeNull();
  });

  it('v2 但 telemetryState 非法 → corrupt', async () => {
    writeFileSync(path.join(dir, SEED_FILE),
      JSON.stringify({ schemaVersion: 2, ...base, telemetryState: 'maybe', decidedAt: null }));
    expect((await readManifest(dir)).status).toBe('corrupt');
  });

  // deleting 是运行期才可能进入的状态（已请求删除、等耐久确认），播种记录里出现即意味着文件被改过或写错了。
  it('v2 且 telemetryState=deleting → corrupt（运行期状态不该出现在播种记录里）', async () => {
    writeFileSync(path.join(dir, SEED_FILE),
      JSON.stringify({ schemaVersion: 2, ...base, telemetryState: 'deleting', decidedAt: null }));
    expect((await readManifest(dir)).status).toBe('corrupt');
  });

  it('v2 且 decidedAt 非字符串非 null → corrupt', async () => {
    writeFileSync(path.join(dir, SEED_FILE),
      JSON.stringify({ schemaVersion: 2, ...base, telemetryState: 'enabled', decidedAt: 123 }));
    expect((await readManifest(dir)).status).toBe('corrupt');
  });

  it('disabled 与 undecided 同样被接受并原样保留', async () => {
    for (const m of [
      { schemaVersion: 2, ...base, telemetryState: 'disabled', decidedAt: '2026-08-05T10:00:00.000Z' },
      { schemaVersion: 2, ...base, telemetryState: 'undecided', decidedAt: null },
    ] satisfies SeedManifest[]) {
      await writeManifest(m, dir);
      expect(await readManifest(dir)).toEqual({ status: 'ok', manifest: m });
    }
  });
});
