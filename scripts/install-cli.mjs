#!/usr/bin/env node
// scripts/install-cli.mjs
// postinstall 入口：把 cli.json 里 pinned 的版本装到 vendor/current/

import { loadManifest } from './cli/manifest.mjs';
import { installOne, reconcileVendor, vendorDir } from './cli/install-one.mjs';

async function main() {
  if (process.env.KYDOG_SKIP_FETCH_BIN === '1') {
    console.log('[install-cli] KYDOG_SKIP_FETCH_BIN=1, skipping');
    return;
  }
  const manifest = loadManifest();
  const tools = Object.entries(manifest.tools);
  if (tools.length === 0) {
    console.log('[install-cli] no tools in manifest, nothing to do');
    return;
  }
  let failed = 0;
  for (const [name, cfg] of tools) {
    try {
      const r = await installOne(name, cfg);
      if (r.skipped) console.log(`[install-cli] ${name}@${cfg.version} already at expected sha, skipping`);
      else console.log(`[install-cli] ${name}@${cfg.version}: installed (${r.sizeBytes} bytes)`);
    } catch (e) {
      console.error(`[install-cli] ${name}@${cfg.version}: FAILED — ${e.message}`);
      failed++;
    }
  }
  reconcileVendor(vendorDir(), manifest);
  if (failed > 0) {
    console.error(`[install-cli] ${failed} tool(s) failed; set KYDOG_SKIP_FETCH_BIN=1 to bypass.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[install-cli] FATAL:', err.message);
  process.exit(1);
});
