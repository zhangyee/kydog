import { promises as fs } from 'node:fs';
import { atomicWrite } from '../persist/atomicWrite';

export interface SkillManifest {
  schemaVersion: 2;
  kydogVersion: string;
  writtenAt: string;
  /** 装过哪些内置 skill。只为孤儿清理服务 —— 这是唯一需要跨启动记忆的东西。 */
  builtin: string[];
}

export type ManifestRead =
  | { kind: 'ok'; builtin: string[] }
  /** 历史列表未知：本轮跳过孤儿清理，但照常同步当前 builtins。 */
  | { kind: 'unknown' };

/**
 * 三档读取，**永不抛**。
 *
 * 会抛的话，`main.ts` 捕获后会跳过整个 skill sync —— 一个坏掉的 manifest
 * 让所有内置 skill 停止更新，这是曾经的真实缺陷。
 *
 * 旧格式（`builtin` 是 `{ name: { files } }` 对象）必须迁移成名字列表，不能并进 unknown：
 * 一旦按 unknown 处理，本轮跳过清理、随后写入的新 manifest 只含当前 builtin，
 * 已删除的旧 builtin 名字永久丢失，孤儿再也认不出来。
 */
export async function readManifest(file: string): Promise<ManifestRead> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'ok', builtin: [] };
    return { kind: 'unknown' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { kind: 'unknown' }; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'unknown' };
  const b = (parsed as { builtin?: unknown }).builtin;
  if (Array.isArray(b) && b.every((x) => typeof x === 'string')) {
    return { kind: 'ok', builtin: b as string[] };
  }
  if (typeof b === 'object' && b !== null && !Array.isArray(b)) {
    return { kind: 'ok', builtin: Object.keys(b as Record<string, unknown>).sort() };  // 旧格式迁移
  }
  return { kind: 'unknown' };
}

export async function writeManifest(file: string, m: SkillManifest): Promise<void> {
  await atomicWrite(file, JSON.stringify(m, null, 2) + '\n');
}
