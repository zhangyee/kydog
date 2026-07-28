#!/usr/bin/env node
// scripts/update-cli.mjs
// cli:update 入口：交互式检查 upstream + 选择性升级

import readline from 'node:readline';
import { loadManifest, saveManifest, TARGETS } from './cli/manifest.mjs';
import { latestStableTag, fetchShaForAsset, fetchDistManifest } from './cli/github.mjs';
import { installOne, reconcileVendor, vendorDir } from './cli/install-one.mjs';

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

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => { rl.close(); resolve(ans); });
  });
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

async function main() {
  const manifest = loadManifest();
  const tools = Object.entries(manifest.tools);
  console.log(`\nChecking ${tools.length} tool${tools.length === 1 ? '' : 's'}…\n`);

  const updated = [];
  const renames = [];
  const failed = [];

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
      continue;
    }
    const arrow = plan.status === 'new' ? '(new)' : cfg.version;
    console.log(`  ${name.padEnd(18)} ${arrow}  →  ${versionFromTag(plan.latest)}`);
    console.log(`                     release notes: ${plan.releaseUrl}`);
    console.log(`                     changes: ${plan.changes.join(', ')}`);
    const ans = (await prompt('  Apply? [y/N]  ')).trim().toLowerCase();
    if (ans !== 'y' && ans !== 'yes') {
      console.log('  skipped.\n');
      continue;
    }
    manifest.tools[name] = plan.newCfg;
    saveManifest(manifest);
    try {
      const r = await installOne(name, plan.newCfg, { force: true });
      console.log(`  installed: vendor/current/${plan.newCfg.binaryName} (${r.sizeBytes} bytes)\n`);
    } catch (e) {
      console.error(`  install FAILED — ${e.message}\n`);
      failed.push(name);
      continue;
    }
    updated.push(`${name}@${plan.newCfg.version}`);
    if (plan.oldBinaryName && plan.oldBinaryName !== plan.newCfg.binaryName) {
      renames.push({ name, from: plan.oldBinaryName, to: plan.newCfg.binaryName });
    }
  }

  reconcileVendor(vendorDir(), manifest);

  console.log('\nSummary:');
  console.log(`  updated: ${updated.length ? updated.join(', ') : '(none)'}`);
  console.log(`  failed:  ${failed.length ? failed.join(', ') : '(none)'}`);

  for (const r of renames) {
    console.log(`\n⚠ ${r.name} binaryName changed: ${r.from} → ${r.to}`);
    console.log(`  Update callers in source before committing:`);
    console.log(`    rg "\\b${r.from}\\b" src/`);
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('[cli:update] FATAL:', err.message);
  process.exit(1);
});
