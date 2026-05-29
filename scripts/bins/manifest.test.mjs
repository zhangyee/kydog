import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadManifestFrom, saveManifestTo, validateManifest } from './manifest.mjs';

const goodManifest = {
  tools: {
    fastpaper: {
      repo: 'zhangyee/fastpaper-cli',
      version: '0.1.0',
      releaseTagTemplate: 'v{version}',
      binaryName: 'fastpaper',
      assets: { 'darwin-arm64': 'a.tar.xz', 'darwin-x64': 'b.tar.xz', 'win32-x64': 'c.zip' },
      sha256: { 'darwin-arm64': 'aa', 'darwin-x64': 'bb', 'win32-x64': 'cc' },
    },
  },
};

describe('manifest', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'bins-manifest-')); });

  it('loadManifestFrom reads and validates JSON', () => {
    const p = path.join(dir, 'bins.json');
    writeFileSync(p, JSON.stringify(goodManifest));
    const m = loadManifestFrom(p);
    expect(m.tools.fastpaper.version).toBe('0.1.0');
  });

  it('saveManifestTo writes atomically (no leftover .tmp)', () => {
    const p = path.join(dir, 'bins.json');
    saveManifestTo(p, goodManifest);
    const files = readdirSync(dir);
    expect(files).toEqual(['bins.json']);
    expect(JSON.parse(readFileSync(p, 'utf-8')).tools.fastpaper.version).toBe('0.1.0');
  });

  it('saveManifestTo round-trip matches', () => {
    const p = path.join(dir, 'bins.json');
    saveManifestTo(p, goodManifest);
    expect(loadManifestFrom(p)).toEqual(goodManifest);
  });

  it('validateManifest rejects missing tools field', () => {
    expect(() => validateManifest({})).toThrow(/tools/);
  });

  it('validateManifest rejects tool missing repo', () => {
    const bad = { tools: { x: { version: '1', releaseTagTemplate: 'v{version}', binaryName: 'x', assets: {}, sha256: {} } } };
    expect(() => validateManifest(bad)).toThrow(/repo/);
  });

  it('validateManifest rejects sha256 with wrong target keys', () => {
    const bad = JSON.parse(JSON.stringify(goodManifest));
    delete bad.tools.fastpaper.sha256['win32-x64'];
    expect(() => validateManifest(bad)).toThrow(/sha256/);
  });
});
