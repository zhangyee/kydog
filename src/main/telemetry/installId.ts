import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { atomicWriteWith0600Sync } from '../persist/atomicWrite';
import * as paths from '../persist/paths';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 仅在统计开启时调用。关闭时该文件根本不存在 ——「不发」与「没有」是两回事。
 *  ID 是纯随机的：绝不从 MAC / 主机名 / 机器码派生，否则删除重装仍是同一身份，
 *  那就成了设备指纹而非伪匿名标识。 */
export function ensureInstallId(): string {
  const p = paths.INSTALL_ID_FILE;
  try {
    const raw = readFileSync(p, 'utf8').trim();
    if (UUID_V4.test(raw)) return raw;
  } catch { /* 不存在或读不出，落到下面重新生成 */ }
  const id = randomUUID();
  atomicWriteWith0600Sync(p, id);
  return id;
}

export function dropInstallId(): void {
  try { unlinkSync(paths.INSTALL_ID_FILE); }
  catch { /* 已经没有就是想要的终态 */ }
}
