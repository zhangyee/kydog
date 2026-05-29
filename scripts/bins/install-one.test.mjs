import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reconcileVendor } from './install-one.mjs';

const goodManifest = {
  tools: {
    fastpaper: {
      repo: 'zhangyee/fastpaper-cli',
      version: '0.1.0',
      releaseTagTemplate: 'v{version}',
      binaryName: 'fastpaper',
      assets: { 'darwin-arm64': 'a', 'darwin-x64': 'b', 'win32-x64': 'c' },
      sha256: { 'darwin-arm64': 'aa', 'darwin-x64': 'bb', 'win32-x64': 'cc' },
    },
  },
};

describe('install-one', () => {
  let vendor;
  beforeEach(() => { vendor = mkdtempSync(path.join(tmpdir(), 'bins-install-')); });
  afterEach(() => { rmSync(vendor, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('reconcileVendor keeps manifest binaries and per-tool sha markers', () => {
    const bin = process.platform === 'win32' ? 'fastpaper.exe' : 'fastpaper';
    writeFileSync(path.join(vendor, bin), 'x');
    writeFileSync(path.join(vendor, '.fastpaper.sha'), 'aa');
    writeFileSync(path.join(vendor, 'stray-file'), 'remove me');
    writeFileSync(path.join(vendor, '.old-name.sha'), 'remove me');
    reconcileVendor(vendor, goodManifest);
    const left = readdirSync(vendor).sort();
    expect(left).toEqual(['.fastpaper.sha', bin].sort());
  });

  it('reconcileVendor leaves vendor empty if manifest has no tools', () => {
    writeFileSync(path.join(vendor, 'leftover'), 'x');
    reconcileVendor(vendor, { tools: {} });
    expect(readdirSync(vendor)).toEqual([]);
  });
});
