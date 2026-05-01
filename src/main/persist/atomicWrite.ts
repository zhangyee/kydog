// src/main/persist/atomicWrite.ts
import { promises as fsp, writeFileSync, renameSync, chmodSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const POSIX = process.platform !== 'win32';
const MODE = 0o600;

/** 兼容旧 callsites（index.json 等其他文件继续用，行为不变）。 */
export async function atomicWrite(target: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${randomUUID()}`;
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, target);
}

/** 凭证文件专用：temp 即 0600 + rename 后 idempotent chmod。 */
export async function atomicWriteWith0600Async(target: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${randomUUID()}`;
  await fsp.writeFile(tmp, data, POSIX ? { encoding: 'utf8', mode: MODE } : 'utf8');
  await fsp.rename(tmp, target);
  if (POSIX) await fsp.chmod(target, MODE);
}

/** 同步版本、専供 SettingsService.withLockSync 走 pi 的同步路径。 */
export function atomicWriteWith0600Sync(target: string, data: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${randomUUID()}`;
  writeFileSync(tmp, data, POSIX ? { encoding: 'utf8', mode: MODE } : 'utf8');
  renameSync(tmp, target);
  if (POSIX) chmodSync(target, MODE);
}
