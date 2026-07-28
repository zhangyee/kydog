// scripts/cli/manifest.mjs
// 读写 scripts/cli.json，原子写，schema 校验

import { readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

export const TARGETS = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
const REQUIRED_TOOL_FIELDS = ['repo', 'version', 'releaseTagTemplate', 'binaryName', 'assets', 'sha256'];

/** 应用只从 src/skills/ 读内置 skill（builtinSkillsRoot + forge extraResource），同步目标必须落在这里 */
const SKILL_DEST_ROOT = 'src/skills';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const DEFAULT_PATH = path.join(REPO_ROOT, 'scripts', 'cli.json');

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
    validateSkill(name, cfg.skill);
  }
}

/** skill 字段可选；一旦存在必须完整，且 dest 必须落在 src/skills/ 下——同步会按上游删 dest 里的本地文件 */
function validateSkill(name, skill) {
  if (skill === undefined) return;
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) {
    throw new Error(`manifest: tool "${name}" skill must be an object`);
  }
  for (const f of ['repoPath', 'dest']) {
    if (typeof skill[f] !== 'string' || skill[f].trim() === '') {
      throw new Error(`manifest: tool "${name}" skill.${f} must be a non-empty string`);
    }
  }
  // 按路径分隔符切段再逐段比对 '..'：既避免把 'v1..v2' 这类合法名字里含 '..' 子串误判为越界，
  // 又同时切分 '/' 和 '\\'，不管 manifest 是在哪个操作系统上写的都能识别 Windows 风格的 '..\\' 逃逸
  const segments = skill.dest.split(/[\\/]/);
  if (path.isAbsolute(skill.dest) || segments.includes('..')) {
    throw new Error(`manifest: tool "${name}" skill.dest must be a repo-relative path without "..": ${skill.dest}`);
  }
  if (!skill.dest.startsWith(`${SKILL_DEST_ROOT}/`) || skill.dest === `${SKILL_DEST_ROOT}/`) {
    throw new Error(`manifest: tool "${name}" skill.dest must be under ${SKILL_DEST_ROOT}/ (the app only loads skills from there): ${skill.dest}`);
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
