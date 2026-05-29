// scripts/bins/install-one.mjs
// 装一个 tool 到 vendor/current/；reconcileVendor 清理多余文件

import { mkdtempSync, readdirSync, existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, renameSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hostTarget, binaryFileName } from './targets.mjs';
import { downloadAndVerify, extractArchive, findFile } from './archive.mjs';
import { releaseAssetUrl } from './github.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const VENDOR_DIR = path.join(REPO_ROOT, 'vendor', 'current');

export function vendorDir() { return VENDOR_DIR; }
export function markerPath(dir, name) { return path.join(dir, `.${name}.sha`); }

export async function installOne(name, cfg, { vendor = VENDOR_DIR, force = false } = {}) {
  const target = hostTarget();
  const expectedSha = cfg.sha256[target];
  const asset = cfg.assets[target];
  const binFile = binaryFileName(cfg.binaryName);
  const finalPath = path.join(vendor, binFile);
  const marker = markerPath(vendor, name);

  if (!force && existsSync(finalPath) && existsSync(marker)) {
    const recorded = readFileSync(marker, 'utf-8').trim();
    if (recorded === expectedSha) return { skipped: true };
  }

  mkdirSync(vendor, { recursive: true });
  const tag = cfg.releaseTagTemplate.replace('{version}', cfg.version);
  const url = releaseAssetUrl(cfg.repo, tag, asset);

  const tmp = mkdtempSync(path.join(tmpdir(), `bins-install-${name}-`));
  try {
    const archive = path.join(tmp, asset);
    await downloadAndVerify(url, expectedSha, archive);
    extractArchive(archive, tmp);
    const located = findFile(tmp, binFile);
    if (!located) throw new Error(`install ${name}: binary "${binFile}" not found in archive ${asset}`);
    const stage = finalPath + '.tmp';
    if (existsSync(stage)) rmSync(stage);
    copyFileSync(located, stage);
    if (process.platform !== 'win32') chmodSync(stage, 0o755);
    if (process.platform === 'win32' && existsSync(finalPath)) rmSync(finalPath);
    renameSync(stage, finalPath);
    writeFileSync(marker, expectedSha + '\n');
    return { skipped: false, sizeBytes: statSync(finalPath).size };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function reconcileVendor(dir, manifest) {
  if (!existsSync(dir)) return;
  const keep = new Set();
  for (const [name, cfg] of Object.entries(manifest.tools)) {
    keep.add(binaryFileName(cfg.binaryName));
    keep.add(`.${name}.sha`);
  }
  for (const ent of readdirSync(dir)) {
    if (!keep.has(ent)) {
      rmSync(path.join(dir, ent), { recursive: true, force: true });
    }
  }
}
