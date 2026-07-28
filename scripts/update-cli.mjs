#!/usr/bin/env node
// scripts/update-cli.mjs
// cli:update 入口：交互式检查 upstream + 选择性升级

import readline from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadManifest, saveManifest, TARGETS } from './cli/manifest.mjs';
import { latestStableTag, fetchShaForAsset, fetchDistManifest, fetchRepoTree } from './cli/github.mjs';
import { installOne, reconcileVendor, vendorDir } from './cli/install-one.mjs';
import { upstreamSkillHashes, localSkillHashes, classifySkill, materializeSkill, applySkill } from './cli/skill-sync.mjs';

// cargo-dist target triple 映射；其他来源的 manifest 形态在此扩展
const CARGO_DIST_TRIPLE = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64':   'x86_64-apple-darwin',
  'win32-x64':    'x86_64-pc-windows-msvc',
};

function isPlaceholder(cfg) {
  return cfg.binaryName === '';
}

function currentTag(cfg) {
  return cfg.releaseTagTemplate.replace('{version}', cfg.version);
}

function versionFromTag(tag) {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

const USAGE = 'usage: npm run cli:update [<tool>[@<version>]]';

/**
 * 解析命令行 → null（没点名 tool）或 { name, version }（version 可为 null）。
 * 以位置参数为规范形式：npm 在不带 `--` 时会自己吞掉 `--tool`，只把值当位置参数递过来，
 * 所以三种敲法（-- --tool X / --tool X / X）必须都落到同一个结果。
 * 畸形输入一律抛错不静默忽略：把 `--verison 0.2.1` 当成"没给参数"会让脚本转头去升最新版。
 */
export function parseToolArg(argv) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tool') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`--tool needs a value. ${USAGE}`);
      values.push(v);
    } else if (a.startsWith('--tool=')) {
      values.push(a.slice('--tool='.length));
    } else if (a.startsWith('-')) {
      throw new Error(`unknown option "${a}". ${USAGE}`);
    } else {
      values.push(a);
    }
  }
  if (values.length === 0) return null;
  if (values.length > 1) throw new Error(`only one tool can be named, got ${values.length}. ${USAGE}`);
  return parseSelector(values[0]);
}

function parseSelector(raw) {
  const parts = raw.split('@');
  if (parts.length > 2) throw new Error(`malformed "${raw}": more than one "@". ${USAGE}`);
  const name = parts[0];
  if (!name) throw new Error(`malformed "${raw}": missing tool name. ${USAGE}`);
  if (parts.length === 2 && !parts[1]) throw new Error(`malformed "${raw}": missing version after "@". ${USAGE}`);
  return { name, version: parts.length === 2 ? parts[1] : null };
}

let rl = null;
let lines = null;
let inputEnded = false;

/**
 * 整个进程共用一个 readline，并从它的异步迭代器逐行取。
 * 每次提问新建接口的话，管道输入下第一个接口会把整段 stdin 一次吞掉，后面的提问再也拿不到行；
 * 迭代器内部自带队列（events.on），没人在等时收到的行也会排好，所以不必自己再缓冲一层。
 * 接口是懒建的：一次都没提问的运行不会碰 stdin，也就不会吊住事件循环。
 */
function prompt(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    lines = rl[Symbol.asyncIterator]();
    inputEnded = false;
    // 必须听 close 事件，不能等迭代器的 done：stdin 到头时 readline 立刻自关，
    // 而此时迭代器里可能还排着没取的行，done 要等这些行取完才来——那时 prompt() 早就抛过了
    rl.on('close', () => { inputEnded = true; });
  }
  // 接口已关时 rl.prompt() 会抛 ERR_USE_AFTER_CLOSE，这时只把问题打出来。
  // 没关就必须走 setPrompt+prompt：终端下用户敲退格会触发 readline 重绘整行，
  // 只 stdout.write 的话 readline 不知道提示词，会拿默认的 "> " 把问题盖掉
  if (inputEnded) process.stdout.write(question);
  else { rl.setPrompt(question); rl.prompt(); }
  // 迭代器结束（EOF 且缓冲取空）时按空答案处理。所有提问都是 [y/N]，空 = 不确认，不会误应用
  return lines.next().then(({ value, done }) => (done ? '' : value));
}

/** [y/N] 确认：只有 y / yes 算同意，空答案（含 EOF）一律算拒绝 */
async function confirm(question) {
  const ans = (await prompt(question)).trim().toLowerCase();
  return ans === 'y' || ans === 'yes';
}

/** 提示用的 readline 一直开着会吊住事件循环；用完必须关。引用一并清掉，之后再提问就是全新一轮 */
function closePrompt() {
  if (rl) { rl.close(); rl = null; lines = null; inputEnded = false; }
}

function discoverFromDistManifest(dm) {
  // 返回 { binaryName, assets } 或 null
  if (!dm || !dm.artifacts) return null;
  const assets = {};
  let binaryName = null;
  for (const [target, triple] of Object.entries(CARGO_DIST_TRIPLE)) {
    for (const [artifactName, artifact] of Object.entries(dm.artifacts)) {
      if (artifact.kind !== 'executable-zip') continue;
      if (!artifact.target_triples?.includes(triple)) continue;
      assets[target] = artifactName;
      if (!binaryName) {
        const execAsset = artifact.assets?.find((a) => a.kind === 'executable');
        if (execAsset?.name) binaryName = execAsset.name;
      }
      break;
    }
  }
  if (!binaryName) return null;
  if (TARGETS.some((t) => !assets[t])) return null;
  return { binaryName, assets };
}

async function checkAndPlan(name, cfg) {
  const latest = await latestStableTag(cfg.repo);
  const placeholder = isPlaceholder(cfg);
  const upToDate = !placeholder && currentTag(cfg) === latest;
  if (upToDate) return { name, status: 'up-to-date', latest };

  // 抓 dist-manifest.json 推断 binaryName/assets
  const dm = await fetchDistManifest(cfg.repo, latest);
  const discovered = discoverFromDistManifest(dm);
  const newCfg = JSON.parse(JSON.stringify(cfg));
  newCfg.version = versionFromTag(latest);
  if (discovered) {
    newCfg.binaryName = discovered.binaryName;
    newCfg.assets = discovered.assets;
  } else if (placeholder) {
    throw new Error(`${name}: upstream ${cfg.repo}@${latest} has no dist-manifest.json; can't auto-discover binaryName/assets. Fill them in scripts/cli.json manually and rerun.`);
  }
  // 抓 sha
  newCfg.sha256 = {};
  for (const t of TARGETS) {
    newCfg.sha256[t] = await fetchShaForAsset(cfg.repo, latest, newCfg.assets[t]);
  }

  const changes = [];
  if (cfg.version !== newCfg.version) changes.push(placeholder ? 'version (new)' : 'version');
  if (cfg.binaryName !== newCfg.binaryName) changes.push(`binaryName (${cfg.binaryName || '(new)'} → ${newCfg.binaryName})`);
  if (JSON.stringify(cfg.assets) !== JSON.stringify(newCfg.assets)) changes.push('assets[*]');
  if (JSON.stringify(cfg.sha256) !== JSON.stringify(newCfg.sha256)) changes.push('sha256[*]');

  return {
    name,
    status: placeholder ? 'new' : 'update',
    latest,
    newCfg,
    changes,
    releaseUrl: `https://github.com/${cfg.repo}/releases/tag/${latest}`,
    oldBinaryName: cfg.binaryName,
  };
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 检查并（经确认后）同步一个 tool 的 skill。
 * tag 用 manifest 里最终生效的版本——升级被跳过时就按旧 tag 比对，保证 skill 与实际装着的二进制同源。
 * 返回 null（无 skill 配置 / 已同步 / 用户跳过）或 { files } 摘要；抛错交给调用方计入 failed。
 */
export async function checkAndSyncSkill(name, cfg) {
  if (!cfg.skill) return null;
  const tag = currentTag(cfg);
  const { repoPath, dest } = cfg.skill;
  const destAbs = path.join(REPO_ROOT, dest);

  const tree = await fetchRepoTree(cfg.repo, tag);
  const upstream = upstreamSkillHashes(tree, repoPath);
  if (Object.keys(upstream).length === 0) {
    throw new Error(`${name}: no files under "${repoPath}" at ${cfg.repo}@${tag} — check skill.repoPath in scripts/cli.json, or the upstream may have moved the directory`);
  }
  const local = localSkillHashes(destAbs);
  const plan = classifySkill({ upstream, local });

  if (plan.status === 'in-sync') {
    console.log(`  ${name.padEnd(18)} skill @ ${tag}  in sync  ✓`);
    return null;
  }

  console.log(`  ${name.padEnd(18)} skill @ ${tag}  →  ${plan.changed.length} changed, ${plan.added.length} added, ${plan.removed.length} removed`);
  for (const [label, rels] of [['changed', plan.changed], ['added', plan.added], ['removed', plan.removed]]) {
    if (rels.length) console.log(`                     ${label}: ${rels.join(', ')}`);
  }

  const tmp = mkdtempSync(path.join(tmpdir(), `cli-skill-${name}-`));
  try {
    await materializeSkill({ repo: cfg.repo, tag, repoPath, rels: [...plan.changed, ...plan.added], tmpDir: tmp });
    for (const rel of plan.changed) {
      printDiff(path.join(destAbs, rel), path.join(tmp, rel), rel);
    }
    if (!await confirm('  Apply? [y/N]  ')) {
      console.log('  skipped.\n');
      return null;
    }
    const r = await applySkill({ srcDir: tmp, destAbs, plan });
    const files = r.written + r.removed;
    console.log(`  synced: ${dest} (${files} file${files === 1 ? '' : 's'})\n`);
    return { files };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 用 git diff --no-index 打彩色 diff；脚本本就跑在 git 仓库里。
 * diff 是应用前唯一的人工闸门，打不出来就必须抛错中断，不能只印一行提示然后照样问 Apply?——
 * 走到这里的都是 blob sha 确实不同的文件，空输出只可能是 git 没跑成，绝不是"没有差异"。
 */
function printDiff(localAbs, upstreamAbs, label) {
  const r = spawnSync('git', ['diff', '--no-index', '--color', '--src-prefix=local/', '--dst-prefix=upstream/', '--', localAbs, upstreamAbs], { encoding: 'utf-8' });
  if (r.error) {
    throw new Error(`can't diff ${label}: failed to run git — ${r.error.message}`);
  }
  // 有差异时 git diff 退出码为 1，这里正是预期；>1 才是真出错
  if (r.status > 1) {
    throw new Error(`can't diff ${label}: git diff exited ${r.status}${r.stderr?.trim() ? ` — ${r.stderr.trim()}` : ''}`);
  }
  if (!r.stdout) {
    throw new Error(`can't diff ${label}: file is classified as changed but git diff produced no output (exit ${r.status}) — git didn't compare the two files as expected`);
  }
  console.log(r.stdout);
}

async function main() {
  const manifest = loadManifest();
  const tools = Object.entries(manifest.tools);
  console.log(`\nChecking ${tools.length} tool${tools.length === 1 ? '' : 's'}…\n`);

  const updated = [];
  const renames = [];
  const failed = [];

  const syncedSkills = [];

  for (const [name, cfg] of tools) {
    let plan;
    try {
      plan = await checkAndPlan(name, cfg);
    } catch (e) {
      console.error(`  ${name.padEnd(18)} FAILED — ${e.message}`);
      failed.push(name);
      continue;
    }

    if (plan.status === 'up-to-date') {
      console.log(`  ${name.padEnd(18)} ${cfg.version}  =  latest  ✓`);
    } else {
      const arrow = plan.status === 'new' ? '(new)' : cfg.version;
      console.log(`  ${name.padEnd(18)} ${arrow}  →  ${versionFromTag(plan.latest)}`);
      console.log(`                     release notes: ${plan.releaseUrl}`);
      console.log(`                     changes: ${plan.changes.join(', ')}`);
      if (await confirm('  Apply? [y/N]  ')) {
        manifest.tools[name] = plan.newCfg;
        saveManifest(manifest);
        try {
          const r = await installOne(name, plan.newCfg, { force: true });
          console.log(`  installed: vendor/current/${plan.newCfg.binaryName} (${r.sizeBytes} bytes)\n`);
        } catch (e) {
          console.error(`  install FAILED — ${e.message}\n`);
          failed.push(name);
          continue;   // 二进制没装成，不碰 skill，避免半新半旧
        }
        updated.push(`${name}@${plan.newCfg.version}`);
        if (plan.oldBinaryName && plan.oldBinaryName !== plan.newCfg.binaryName) {
          renames.push({ name, from: plan.oldBinaryName, to: plan.newCfg.binaryName });
        }
      } else {
        console.log('  skipped.\n');
        // 这里不 continue：二进制升级被拒，skill 仍要按当前（旧）tag 比对一遍
      }
    }

    // skill 按 manifest 里最终生效的版本比对（升级已应用则是新 tag，否则仍是旧 tag）
    try {
      const s = await checkAndSyncSkill(name, manifest.tools[name]);
      if (s) syncedSkills.push(`${name}@${currentTag(manifest.tools[name])} (${s.files} file${s.files === 1 ? '' : 's'})`);
    } catch (e) {
      console.error(`  ${name.padEnd(18)} skill FAILED — ${e.message}`);
      failed.push(`${name} (skill)`);
    }
  }

  reconcileVendor(vendorDir(), manifest);
  closePrompt();

  console.log('\nSummary:');
  console.log(`  updated: ${updated.length ? updated.join(', ') : '(none)'}`);
  console.log(`  skills:  ${syncedSkills.length ? syncedSkills.join(', ') : '(none)'}`);
  console.log(`  failed:  ${failed.length ? failed.join(', ') : '(none)'}`);

  for (const r of renames) {
    console.log(`\n⚠ ${r.name} binaryName changed: ${r.from} → ${r.to}`);
    console.log(`  Update callers in source before committing:`);
    console.log(`    rg "\\b${r.from}\\b" src/`);
  }

  process.exit(failed.length ? 1 : 0);
}

// 只在被当脚本直接执行时跑 main()。测试要 import checkAndSyncSkill，
// 而模块顶层无条件跑 main() 的话，一 import 就会走完整条交互流程并 process.exit
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[cli:update] FATAL:', err.message);
    process.exit(1);
  });
}
