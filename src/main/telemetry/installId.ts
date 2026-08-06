import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { atomicWriteWith0600Sync } from '../persist/atomicWrite';
import * as paths from '../persist/paths';
// 判定用契约里那一份，不在这里另起：这个正则决定「哪些内容会被当成标识发给服务端」，
// 服务端拿同一份字面量校验。本地再写一份就是两份定义漂开的起点（曾经的那份漏了 /i，
// 于是一个服务端会照收的 ID 在客户端被判成损坏、静默换一个新标识）。
import { UUID_V4_RE } from '../../shared/telemetryContract';

/** 只读：读不到就是没有。与 ensureInstallId 的区别是它绝不创建 ——
 *  删除路径上凭空造一个服务端从没见过的标识，比不删更糟。 */
export function readInstallId(): string | null {
  try {
    const raw = readFileSync(paths.INSTALL_ID_FILE, 'utf8').trim();
    return UUID_V4_RE.test(raw) ? raw : null;
  } catch { return null; /* 不存在或读不出 */ }
}

/** 仅在统计开启时调用。关闭时该文件根本不存在 ——「不发」与「没有」是两回事。
 *  ID 是纯随机的：绝不从 MAC / 主机名 / 机器码派生，否则删除重装仍是同一身份，
 *  那就成了设备指纹而非伪匿名标识。 */
export function ensureInstallId(): string {
  const existing = readInstallId();
  if (existing) return existing;
  const id = randomUUID();
  atomicWriteWith0600Sync(paths.INSTALL_ID_FILE, id);
  return id;
}

export function dropInstallId(): void {
  try { unlinkSync(paths.INSTALL_ID_FILE); }
  catch { /* 已经没有就是想要的终态 */ }
}
