import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
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
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'cli-manifest-')); });

  it('loadManifestFrom reads and validates JSON', () => {
    const p = path.join(dir, 'cli.json');
    writeFileSync(p, JSON.stringify(goodManifest));
    const m = loadManifestFrom(p);
    expect(m.tools.fastpaper.version).toBe('0.1.0');
  });

  it('saveManifestTo writes atomically (no leftover .tmp)', () => {
    const p = path.join(dir, 'cli.json');
    saveManifestTo(p, goodManifest);
    const files = readdirSync(dir);
    expect(files).toEqual(['cli.json']);
    expect(JSON.parse(readFileSync(p, 'utf-8')).tools.fastpaper.version).toBe('0.1.0');
  });

  it('saveManifestTo round-trip matches', () => {
    const p = path.join(dir, 'cli.json');
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

  it('validateManifest accepts a tool without skill', () => {
    expect(() => validateManifest(goodManifest)).not.toThrow();
  });

  it('validateManifest accepts a well-formed skill', () => {
    const m = JSON.parse(JSON.stringify(goodManifest));
    m.tools.fastpaper.skill = { repoPath: 'skills/fastpaper', dest: 'src/skills/fastpaper' };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('validateManifest rejects a non-object skill', () => {
    const m = JSON.parse(JSON.stringify(goodManifest));
    m.tools.fastpaper.skill = 'skills/fastpaper';
    expect(() => validateManifest(m)).toThrow(/skill must be an object/);
  });

  it('validateManifest rejects skill missing repoPath', () => {
    const m = JSON.parse(JSON.stringify(goodManifest));
    m.tools.fastpaper.skill = { dest: 'src/skills/fastpaper' };
    expect(() => validateManifest(m)).toThrow(/skill\.repoPath/);
  });

  it('validateManifest rejects an empty dest', () => {
    const m = JSON.parse(JSON.stringify(goodManifest));
    m.tools.fastpaper.skill = { repoPath: 'skills/fastpaper', dest: '  ' };
    expect(() => validateManifest(m)).toThrow(/skill\.dest/);
  });

  it('validateManifest rejects an absolute dest (sync deletes files — must stay in-repo)', () => {
    const m = JSON.parse(JSON.stringify(goodManifest));
    m.tools.fastpaper.skill = { repoPath: 'skills/fastpaper', dest: '/etc/skills' };
    expect(() => validateManifest(m)).toThrow(/repo-relative/);
  });

  it('validateManifest rejects a dest escaping the repo with ..', () => {
    const m = JSON.parse(JSON.stringify(goodManifest));
    m.tools.fastpaper.skill = { repoPath: 'skills/fastpaper', dest: '../../evil' };
    expect(() => validateManifest(m)).toThrow(/repo-relative/);
  });

  it('validateManifest rejects a dest outside src/skills (sync deletes everything under dest)', () => {
    const m = JSON.parse(JSON.stringify(goodManifest));
    m.tools.fastpaper.skill = { repoPath: 'skills/fastpaper', dest: 'src' };
    expect(() => validateManifest(m)).toThrow(/must be under src\/skills/);
  });

  it('validateManifest rejects src/skills itself as dest', () => {
    const m = JSON.parse(JSON.stringify(goodManifest));
    m.tools.fastpaper.skill = { repoPath: 'skills/fastpaper', dest: 'src/skills' };
    expect(() => validateManifest(m)).toThrow(/must be under src\/skills/);
  });
});
