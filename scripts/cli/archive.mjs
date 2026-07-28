// scripts/cli/archive.mjs
// 下载（sha 校验）+ 解压 + 在解压目录里按名字定位文件

import { createHash } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export async function downloadAndVerify(url, expectedSha, dest) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  let bytes;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error(`download failed (${res.status} ${res.statusText}): ${url}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  const gotSha = createHash('sha256').update(bytes).digest('hex');
  if (gotSha !== expectedSha) {
    throw new Error(`sha256 mismatch for ${url}: expected ${expectedSha}, got ${gotSha}`);
  }
  writeFileSync(dest, bytes);
}

export function extractArchive(archive, outDir) {
  if (archive.endsWith('.zip')) {
    const tar = spawnSync('tar', ['-xf', archive, '-C', outDir], { stdio: 'inherit' });
    if (tar.status === 0) return;
    const ps = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'inherit' });
    if (ps.status !== 0) throw new Error(`zip extract failed for ${archive}`);
    return;
  }
  const r = spawnSync('tar', ['-xJf', archive, '-C', outDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar -xJf failed for ${archive}`);
}

export function findFile(dir, name) {
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name === name) return p;
    }
  }
  return null;
}
