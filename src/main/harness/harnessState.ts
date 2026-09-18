import { promises as fsp } from 'node:fs';
import path from 'node:path';
import * as paths from '../persist/paths';
import { atomicWriteWith0600Async } from '../persist/atomicWrite';
import { HARNESS_FILE_NAMES, type HarnessFileName } from '../../shared/types';
import type { HarnessRecord } from './harnessAssess';
import { logger } from '../log';

/** `~/.kydog/.harness-state.json`：三份 harness 文件各自「写入时用的哪一版模板、对哪一版选过保持」（spec §3.1）。 */
export const HARNESS_STATE_FILE = '.harness-state.json';

export type HarnessState = {
  schemaVersion: 1;
  files: Partial<Record<HarnessFileName, HarnessRecord>>;
};

const empty = (): HarnessState => ({ schemaVersion: 1, files: {} });

function isRecord(v: unknown): v is HarnessRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const keptOk = r.keptTemplateSha === null || typeof r.keptTemplateSha === 'string';
  // 两者同为 null（老用户选过保持）或同为有值，不许一半一半。
  const known = (r.locale === 'zh' || r.locale === 'en') && typeof r.template === 'string';
  const unknown = r.locale === null && r.template === null;
  return keptOk && (known || unknown);
}

function parse(raw: string): HarnessState | null {
  let p: unknown;
  try { p = JSON.parse(raw); } catch { return null; }
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (o.schemaVersion !== 1 || typeof o.files !== 'object' || o.files === null) return null;
  const files: HarnessState['files'] = {};
  for (const [name, rec] of Object.entries(o.files as Record<string, unknown>)) {
    if (!(HARNESS_FILE_NAMES as readonly string[]).includes(name) || !isRecord(rec)) return null;
    files[name as HarnessFileName] = { locale: rec.locale, template: rec.template, keptTemplateSha: rec.keptTemplateSha };
  }
  return { schemaVersion: 1, files };
}

/**
 * 不存在 → 没有记录；结构不合 → 改名成 .bad、按没有记录处理（与 manifest 同一套做法）。
 * 其余读错误（权限、被占用）**抛出去**，不当成「没有记录」：调用方下一步多半要写回，
 * 拿一份空状态写回去，就把别的文件的记录（包括用户选过的「保持」）一起抹掉了。
 */
export async function readHarnessState(dir: string = paths.ROOT): Promise<HarnessState> {
  const file = path.join(dir, HARNESS_STATE_FILE);
  let raw: string;
  try { raw = await fsp.readFile(file, 'utf8'); }
  catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return empty();
    throw err;
  }
  const s = parse(raw);
  if (s) return s;
  try { await fsp.rename(file, file + '.bad'); logger.warn('harness.state', 'corrupt state discarded to .bad', {}); }
  catch (err) { logger.warn('harness.state', 'discard failed', { err: String(err) }); }
  return empty();
}

export async function writeHarnessState(s: HarnessState, dir: string = paths.ROOT): Promise<void> {
  await atomicWriteWith0600Async(path.join(dir, HARNESS_STATE_FILE), JSON.stringify(s, null, 2));
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * 进程内串行队列。status 的补记、apply、write、seed 都会读-改-写同一份状态（apply / write
 * 还要先比对磁盘上的 harness 文件），整段放进来一气做完，互相之间不会覆盖。
 * 队列里的函数不要再调 withHarnessLock —— 会等自己，死锁。
 */
export function withHarnessLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(() => fn());
  tail = run.catch(() => {});
  return run;
}
