// scripts/cli/skill-sync.mjs
// 上游 skill 目录 → src/skills/<name>/ 的同步：blob sha 判等、差异分类、暂存、应用

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { fetchRepoFile } from './github.mjs';

/** Finder 生成、.gitignore 已忽略；纳入比对会变成每次都出现的假漂移 */
const IGNORED_FILES = new Set(['.DS_Store']);

/** 软链没有 blob sha，也不该留在纯 vendor 副本里；用一个永不等于真 sha 的哨兵值，
 *  让它要么被判为 changed（上游有同名文件）要么被判为 removed（上游没有），总之不会静默留下 */
const SYMLINK_SHA = 'symlink';

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
    // 软链要先判：readdirSync 的 Dirent 走的是 lstat 语义，软链的 isDirectory()/isFile() 都是 false，
    // 不单独认出来就会被整个跳过——既不会被判 removed（永远删不掉），
    // 上游有同名文件时还会因为不在 local 里而被判成 added，写入时跟着链跑到目录外
    if (ent.isSymbolicLink()) out[childRel] = SYMLINK_SHA;
    else if (ent.isDirectory()) walk(root, childRel, out);
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

/**
 * 把 tmpDir 里已下好的文件搬到 destAbs，并删掉上游已不存在的本地文件。
 *
 * 顺序是「先删后写」，不要改回「先写后删」——两个真实存在的 bug 都出在这个顺序上：
 *
 * 1. 软链子目录逃逸：dest/references 是指向目录外的软链，上游有 references/x.md，
 *    于是 plan 是 added:['references/x.md'] + removed:['references']。先写的话
 *    mkdirSync(recursive) 见到已存在的链就直接放行，writeFileSync 跟着链把文件写到了 dest 外面。
 *    写入前那句 rmSync 只删叶子，救不了经由父级路径段的逃逸——只有先把链删掉才行。
 * 2. 大小写改名丢文件：上游把 foo.md 改名成 Foo.md，plan 是 added:['Foo.md'] + removed:['foo.md']。
 *    在大小写不敏感的文件系统（macOS 默认，本项目主力开发平台）上这两者是同一个目录项，
 *    先写 Foo.md 再 rmSync('foo.md') 等于把刚写好的内容删了个干净，而同步还报成功。
 *
 * 普通路径下这个顺序不可观测：classifySkill 的 removed 来自 upstream 里没有的 key，
 * changed/added 来自 upstream 里有的 key，两个集合天然不相交。
 */
export async function applySkill({ srcDir, destAbs, plan }) {
  const toWrite = [...plan.changed, ...plan.added];
  // 先把这次会碰到的每个 rel 都校验一遍，再动手写/删——避免校验途中中止时已经半应用
  for (const rel of toWrite) assertSafeRel(rel, 'applySkill');
  for (const rel of plan.removed) assertSafeRel(rel, 'applySkill');

  mkdirSync(destAbs, { recursive: true });
  for (const rel of plan.removed) {
    rmSync(path.join(destAbs, rel), { force: true });
  }
  for (const rel of toWrite) {
    const abs = path.join(destAbs, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    // 先 unlink 再写：目标位置若是软链，writeFileSync 会跟着链把内容写到目录外的真身上。
    // rmSync 删的是链本身而不是它指向的文件，所以这里既堵住了越界写，也不会误删链外的东西
    rmSync(abs, { force: true });
    writeFileSync(abs, readFileSync(path.join(srcDir, rel)));
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
