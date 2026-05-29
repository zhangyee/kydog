// scripts/bins/archive.mjs
// 下载（sha 校验）+ 解压 + 启发式定位 binary

import { createHash } from 'node:crypto';
import { createWriteStream, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
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

export function discoverExecutable(dir) {
  const candidates = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) { stack.push(p); continue; }
      if (!ent.isFile()) continue;
      if (process.platform === 'win32') {
        if (ent.name.toLowerCase().endsWith('.exe')) candidates.push(ent.name);
      } else {
        const mode = statSync(p).mode;
        // any exec bit set
        if (mode & 0o111) candidates.push(ent.name);
      }
    }
  }
  if (candidates.length === 0) throw new Error(`discoverExecutable: no executable found in ${dir}`);
  if (candidates.length > 1) {
    throw new Error(`discoverExecutable: multiple executable candidates in ${dir}: ${candidates.join(', ')}`);
  }
  return candidates[0];
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
