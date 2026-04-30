#!/usr/bin/env node
// scripts/fetch-bin.mjs
// Fetches the host-platform fastpaper binary into vendor/current/.
// Run by `npm postinstall`. Idempotent: skips download if vendor/current/ already
// has the right binary by sha256.

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync, statSync, copyFileSync, renameSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..');
const CHECKSUMS = path.join(REPO_ROOT, 'scripts', 'checksums.json');
const VENDOR_DIR = path.join(REPO_ROOT, 'vendor', 'current');

export function mapPlatformArch(platform, arch) {
  const key = `${platform}-${arch}`;
  const allowed = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64']);
  if (!allowed.has(key)) {
    throw new Error(`unsupported platform/arch: ${key} (supported: ${[...allowed].join(', ')})`);
  }
  return key;
}

export function assetForTarget(target) {
  const map = JSON.parse(readFileSync(CHECKSUMS, 'utf-8')).fastpaper.assets;
  const a = map[target];
  if (!a) throw new Error(`no asset configured for target ${target}`);
  return a;
}

export function urlFor({ template, version, asset }) {
  return template.replaceAll('{version}', version).replaceAll('{asset}', asset);
}

function sha256OfFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function downloadTo(url, dest) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) throw new Error(`download failed (${res.status} ${res.statusText}): ${url}`);
    if (!res.body) throw new Error(`download returned empty body: ${url}`);
    await pipeline(res.body, createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
}

function extractTarXz(archive, outDir) {
  const r = spawnSync('tar', ['-xJf', archive, '-C', outDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar -xJf failed for ${archive}`);
}

function extractZip(archive, outDir) {
  const tar = spawnSync('tar', ['-xf', archive, '-C', outDir], { stdio: 'inherit' });
  if (tar.status === 0) return;
  const ps = spawnSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${outDir.replace(/'/g, "''")}' -Force`,
  ], { stdio: 'inherit' });
  if (ps.status !== 0) throw new Error(`zip extract failed for ${archive}`);
}

function locateBinary(dir, expectedName) {
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name === expectedName) return p;
    }
  }
  throw new Error(`${expectedName} not found inside ${dir}`);
}

async function main() {
  if (process.env.KYDOG_SKIP_FETCH_BIN === '1') {
    console.log('[fetch-bin] KYDOG_SKIP_FETCH_BIN=1, skipping');
    return;
  }
  const target = mapPlatformArch(process.platform, process.arch);
  const cfg = JSON.parse(readFileSync(CHECKSUMS, 'utf-8')).fastpaper;
  const asset = assetForTarget(target);
  const expectedSha = cfg.sha256[target];
  if (!expectedSha || expectedSha.startsWith('TODO')) {
    throw new Error(`scripts/checksums.json: sha256[${target}] not filled in (got "${expectedSha}")`);
  }
  const expectedBin = process.platform === 'win32' ? 'fastpaper.exe' : 'fastpaper';
  const finalPath = path.join(VENDOR_DIR, expectedBin);
  const markerPath = path.join(VENDOR_DIR, '.fetched-sha');

  if (existsSync(finalPath) && existsSync(markerPath)) {
    const recordedSha = readFileSync(markerPath, 'utf-8').trim();
    if (recordedSha === expectedSha) {
      console.log(`[fetch-bin] ${finalPath} already at sha ${expectedSha.slice(0, 12)}…, skipping`);
      return;
    }
  }

  mkdirSync(VENDOR_DIR, { recursive: true });
  const tmp = await mkdtemp(path.join(tmpdir(), 'kydog-fetchbin-'));
  try {
    const archive = path.join(tmp, asset);
    const url = urlFor({ template: cfg.release, version: cfg.version, asset });
    console.log(`[fetch-bin] downloading ${url}`);
    await downloadTo(url, archive);
    const gotSha = sha256OfFile(archive);
    if (gotSha !== expectedSha) {
      throw new Error(`sha256 mismatch for ${asset}: expected ${expectedSha}, got ${gotSha}`);
    }
    if (asset.endsWith('.zip')) extractZip(archive, tmp);
    else extractTarXz(archive, tmp);
    const located = locateBinary(tmp, expectedBin);
    const stagePath = finalPath + '.tmp';
    if (existsSync(stagePath)) rmSync(stagePath);
    copyFileSync(located, stagePath);
    if (process.platform !== 'win32') chmodSync(stagePath, 0o755);
    // On POSIX, renameSync atomically replaces an existing finalPath in one syscall.
    // On Windows, rename over an existing file fails, so the explicit rm is needed.
    if (process.platform === 'win32' && existsSync(finalPath)) rmSync(finalPath);
    renameSync(stagePath, finalPath);
    writeFileSync(markerPath, expectedSha + '\n');
    const finalSize = statSync(finalPath).size;
    console.log(`[fetch-bin] wrote ${finalPath} (${finalSize} bytes)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fetch-bin.mjs')) {
  main().catch((err) => {
    console.error('[fetch-bin] FAILED:', err.message);
    console.error('[fetch-bin] If this persists: check network/proxy, or set KYDOG_SKIP_FETCH_BIN=1 to bypass and place the binary in vendor/current/ manually.');
    process.exit(1);
  });
}
