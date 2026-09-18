// src/main/persist/atomicWrite.ts
import { promises as fsp, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const POSIX = process.platform !== 'win32';
const MODE = 0o600;

/** 兼容旧 callsites（index.json 等其他文件继续用，行为不变）。失败时删掉临时文件，与 atomicWriteBytes 一致。 */
export async function atomicWrite(target: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${randomUUID()}`;
  try {
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** 二进制版。PNG 之类的产物用它：tmp + rename，写一半崩掉不会留下截断的文件，
 *  rename 也不跟随符号链接（目标若是 symlink，被换掉的是链接本身）。 */
export async function atomicWriteBytes(target: string, data: Uint8Array): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${randomUUID()}`;
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** 凭证文件专用：temp 即 0600 + rename 后 idempotent chmod。 */
export async function atomicWriteWith0600Async(target: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${randomUUID()}`;
  await fsp.writeFile(tmp, data, POSIX ? { encoding: 'utf8', mode: MODE } : 'utf8');
  await fsp.rename(tmp, target);
  if (POSIX) await fsp.chmod(target, MODE);
}

/** 同步版。d712007 曾因「失去调用者」删掉它，现在遥测的 install-id 与 last-beacon
 *  又需要它了 —— 那两处是启动期的一次几十字节写入，改成异步会把调用链上所有
 *  同步初始化逻辑一并染成异步，代价大于收益。 */
export function atomicWriteWith0600Sync(target: string, data: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${randomUUID()}`;
  writeFileSync(tmp, data, POSIX ? { encoding: 'utf8', mode: MODE } : 'utf8');
  renameSync(tmp, target);
  if (POSIX) chmodSync(target, MODE);
}
