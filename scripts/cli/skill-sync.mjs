// scripts/cli/skill-sync.mjs
// 上游 skill 目录 → src/skills/<name>/ 的同步：blob sha 判等、差异分类、暂存、应用

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/** Finder 生成、.gitignore 已忽略；纳入比对会变成每次都出现的假漂移 */
const IGNORED_FILES = new Set(['.DS_Store']);

/** git 的 blob 对象 id：sha1("blob <字节数>\0" + 内容)。与 `git hash-object` 一致。 */
export function gitBlobSha(buf) {
  return createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

/** 递归扫描本地 skill 目录 → { 相对路径(posix): blobSha }；目录不存在返回 {} */
export function localSkillHashes(destAbs) {
  const out = {};
  if (!existsSync(destAbs)) return out;
  walk(destAbs, '', out);
  return out;
}

function walk(root, rel, out) {
  const here = rel ? path.join(root, rel) : root;
  for (const ent of readdirSync(here, { withFileTypes: true })) {
    if (IGNORED_FILES.has(ent.name)) continue;
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, childRel, out);
    else if (ent.isFile()) out[childRel] = gitBlobSha(readFileSync(path.join(root, childRel)));
  }
}
