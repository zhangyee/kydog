// scripts/cli/skill-sync.mjs
// 上游 skill 目录 → src/skills/<name>/ 的同步：blob sha 判等、差异分类、暂存、应用

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { fetchRepoFile } from './github.mjs';

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

/** 从 tree 数组过滤出 repoPath 下的 blob → { 相对路径: blobSha } */
export function upstreamSkillHashes(tree, repoPath) {
  const prefix = `${repoPath}/`;
  const out = {};
  for (const e of tree) {
    if (e.type !== 'blob') continue;
    if (!e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    assertSafeRel(rel, 'upstream tree');
    if (IGNORED_FILES.has(path.posix.basename(rel))) continue;
    out[rel] = e.sha;
  }
  return out;
}

/** 上游 vs 本地 → { status, changed[], added[], removed[] }，每个桶已排序 */
export function classifySkill({ upstream, local }) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, sha] of Object.entries(upstream)) {
    if (!(rel in local)) added.push(rel);
    else if (local[rel] !== sha) changed.push(rel);
  }
  for (const rel of Object.keys(local)) {
    if (!(rel in upstream)) removed.push(rel);
  }
  changed.sort();
  added.sort();
  removed.sort();
  const status = changed.length + added.length + removed.length === 0 ? 'in-sync' : 'differs';
  return { status, changed, added, removed };
}

/** 把上游这些相对路径的文件下载到 tmpDir（供 diff 展示与随后的写入复用，只下一次） */
export async function materializeSkill({ repo, tag, repoPath, rels, tmpDir, fetchFile = fetchRepoFile }) {
  for (const rel of rels) {
    assertSafeRel(rel, 'materializeSkill');
    const buf = await fetchFile(repo, tag, `${repoPath}/${rel}`);
    const abs = path.join(tmpDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, buf);
  }
}

/** 把 tmpDir 里已下好的文件搬到 destAbs，并删掉上游已不存在的本地文件 */
export async function applySkill({ srcDir, destAbs, plan }) {
  const toWrite = [...plan.changed, ...plan.added];
  // 先把这次会碰到的每个 rel 都校验一遍，再动手写/删——避免校验途中中止时已经半应用
  for (const rel of toWrite) assertSafeRel(rel, 'applySkill');
  for (const rel of plan.removed) assertSafeRel(rel, 'applySkill');

  mkdirSync(destAbs, { recursive: true });
  for (const rel of toWrite) {
    const abs = path.join(destAbs, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, readFileSync(path.join(srcDir, rel)));
  }
  for (const rel of plan.removed) {
    rmSync(path.join(destAbs, rel), { force: true });
  }
  pruneEmptyDirs(destAbs);
  return { written: toWrite.length, removed: plan.removed.length };
}

/** 删掉 destAbs 下变空的子目录；destAbs 自身保留 */
function pruneEmptyDirs(destAbs) {
  for (const ent of readdirSync(destAbs, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const abs = path.join(destAbs, ent.name);
    pruneEmptyDirs(abs);
    if (readdirSync(abs).length === 0) rmdirSync(abs);
  }
}

/**
 * rel 只能是 dest/tmpDir 内的相对路径。
 * 三处调用点各自校验自己的输入，不假设上游调用点已经查过：upstreamSkillHashes 是网络数据进系统的边界，
 * 而 materializeSkill / applySkill 都是导出函数，可以被直接调用。少任何一处都会留下一条能写/删到目录外的路。
 */
function assertSafeRel(rel, where) {
  const segments = rel.split(/[\\/]/);
  if (path.isAbsolute(rel) || segments.includes('..') || segments.includes('')) {
    throw new Error(`${where}: refusing to touch a path outside the skill dir: ${rel}`);
  }
}
