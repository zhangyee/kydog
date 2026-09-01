import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cached: boolean | null = null;

/**
 * 这台机器**能不能建符号链接**。探针式判定：真去建一个再删掉，不猜平台。
 *
 * Windows 上建符号链接要 `SeCreateSymbolicLinkPrivilege`，普通用户默认没有，
 * `fs.symlink` 直接抛 EPERM。拿到这项特权有两条路：以管理员运行，或者
 * **打开「开发者模式」**（设置 → 系统 → 开发者选项）—— 后者是一次性开关，
 * 开完普通用户就一直有，不必每次开管理员窗口。
 *
 * 为什么要探针而不是 `process.platform === 'win32'`：开了开发者模式的 Windows
 * 是能建的，按平台一刀切会把那些机器上的覆盖也一起跳掉 —— 那正是这批用例最该跑的地方。
 */
export function canCreateSymlink(): boolean {
  if (cached !== null) return cached;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'kydog-symcap-'));
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'x');
    symlinkSync(target, join(dir, 'link.txt'));
    cached = true;
  } catch {
    cached = false;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}

/**
 * 是否**要求**符号链接可用。CI 里设 `KYDOG_REQUIRE_SYMLINK=1`。
 *
 * 没有这道闸，「本机跳过」这套机制会一路跳到 CI 里去 —— 一批安全用例（软链能不能
 * 越出目录、写入会不会穿透链接）在发版流水线上静默消失，而绿灯照常亮。
 */
export function symlinkRequired(): boolean {
  return process.env.KYDOG_REQUIRE_SYMLINK === '1';
}

/**
 * 传给 `it.skipIf(...)` / `test.skip(...)` 的条件。
 *
 * 建不了 → 跳过（本机开发不再无端飘红）；但只要 CI 要求了，就不跳 ——
 * 让它跑下去、在 symlink 那一行以 EPERM 炸出来，红得明明白白。
 */
export const SKIP_WITHOUT_SYMLINK = !canCreateSymlink() && !symlinkRequired();

/** 跳过时给人看的原因，别让 skip 成为一条没人看得懂的静默记录。 */
export const SYMLINK_SKIP_REASON =
  '需要创建符号链接的权限：Windows 上请打开「开发者模式」（一次性），或以管理员运行；CI 里设 KYDOG_REQUIRE_SYMLINK=1 强制要求';
