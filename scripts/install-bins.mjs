#!/usr/bin/env node
// scripts/install-bins.mjs
// postinstall 入口：把 bins.json 里 pinned 的版本装到 vendor/current/

import { loadManifest } from './bins/manifest.mjs';
import { installOne, reconcileVendor, vendorDir } from './bins/install-one.mjs';

async function main() {
  if (process.env.KYDOG_SKIP_FETCH_BIN === '1') {
    console.log('[install-bins] KYDOG_SKIP_FETCH_BIN=1, skipping');
    return;
  }
  const manifest = loadManifest();
  const tools = Object.entries(manifest.tools);
  if (tools.length === 0) {
    console.log('[install-bins] no tools in manifest, nothing to do');
    return;
  }
  let failed = 0;
  for (const [name, cfg] of tools) {
    try {
      const r = await installOne(name, cfg);
      if (r.skipped) console.log(`[install-bins] ${name}@${cfg.version} already at expected sha, skipping`);
      else console.log(`[install-bins] ${name}@${cfg.version}: installed (${r.sizeBytes} bytes)`);
    } catch (e) {
      console.error(`[install-bins] ${name}@${cfg.version}: FAILED — ${e.message}`);
      failed++;
    }
  }
  reconcileVendor(vendorDir(), manifest);
  if (failed > 0) {
    console.error(`[install-bins] ${failed} tool(s) failed; set KYDOG_SKIP_FETCH_BIN=1 to bypass.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[install-bins] FATAL:', err.message);
  process.exit(1);
});
