// scripts/bins/manifest.mjs
// 读写 scripts/bins.json，原子写，schema 校验

import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

export const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const REQUIRED_TOOL_FIELDS = ['repo', 'version', 'releaseTagTemplate', 'binaryName', 'assets', 'sha256'];

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_PATH = path.join(REPO_ROOT, 'scripts', 'bins.json');

export function validateManifest(m) {
  if (!m || typeof m !== 'object' || !m.tools || typeof m.tools !== 'object') {
    throw new Error('manifest: missing or invalid "tools" field');
  }
  for (const [name, cfg] of Object.entries(m.tools)) {
    for (const f of REQUIRED_TOOL_FIELDS) {
      if (!(f in cfg)) throw new Error(`manifest: tool "${name}" missing field "${f}"`);
    }
    for (const t of TARGETS) {
      if (!(t in cfg.assets)) throw new Error(`manifest: tool "${name}" assets missing target "${t}"`);
      if (!(t in cfg.sha256)) throw new Error(`manifest: tool "${name}" sha256 missing target "${t}"`);
    }
  }
}

export function loadManifestFrom(file) {
  const raw = readFileSync(file, 'utf-8');
  const m = JSON.parse(raw);
  validateManifest(m);
  return m;
}

export function loadManifest() {
  return loadManifestFrom(DEFAULT_PATH);
}

export function saveManifestTo(file, m) {
  validateManifest(m);
  const tmp = file + '.tmp';
  if (existsSync(tmp)) rmSync(tmp);
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  // POSIX rename 原子替换；Windows 如目标存在需先删
  if (process.platform === 'win32' && existsSync(file)) rmSync(file);
  renameSync(tmp, file);
}

export function saveManifest(m) {
  saveManifestTo(DEFAULT_PATH, m);
}

export { DEFAULT_PATH as MANIFEST_PATH };
