// POSIX-only test fixtures (`#!/bin/sh` scripts). Project does not run main-process
// vitest on Windows in CI, so the timeout test does not need a Windows variant.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ExternalBinEntry } from '../../shared/types';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
}));

import { ToolsService } from './toolsService';

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'tools-'));
}

// Any test asserting a real `--version` string must state its own spawn budget instead
// of inheriting the 1500ms production default: under a full `npm test` run the suites
// go in parallel, and spawning `/bin/sh` on a loaded machine can exceed 1500ms, making
// detectVersion time out and report version=null. The per-test timeout is raised to
// match so vitest's own 5s default is not the binding constraint either.
const SPAWN_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 15_000;

describe('ToolsService.list', () => {
  it('lists executables and their --version', async () => {
    const dir = tmp();
    const fp = path.join(dir, 'fastpaper');
    writeFileSync(fp, '#!/bin/sh\necho 1.4.0\n');
    chmodSync(fp, 0o755);
    const svc = new ToolsService({ binDir: () => dir, ttlMs: 1000, spawnTimeoutMs: SPAWN_TIMEOUT_MS });
    const list = await svc.list();
    expect(list[0].name).toBe('fastpaper');
    expect(list[0].version).toBe('1.4.0');
    expect(list[0].path).toBe(fp);
    expect(list[0].origin).toBe('builtin');
  }, TEST_TIMEOUT_MS);

  it('handles --version timeout → version=null', async () => {
    const dir = tmp();
    const fp = path.join(dir, 'slow');
    writeFileSync(fp, '#!/bin/sh\nsleep 5\n');
    chmodSync(fp, 0o755);
    const svc = new ToolsService({ binDir: () => dir, ttlMs: 1000, spawnTimeoutMs: 200 });
    const list = await svc.list();
    expect(list[0].version).toBe(null);
  }, 10000);

  it('caches under TTL, refetches on force', async () => {
    const dir = tmp();
    const fp = path.join(dir, 'tool');
    writeFileSync(fp, '#!/bin/sh\necho 1\n');
    chmodSync(fp, 0o755);
    const svc = new ToolsService({
      binDir: () => dir,
      ttlMs: 1_000_000,
      spawnTimeoutMs: SPAWN_TIMEOUT_MS,
    });
    const a = await svc.list();
    expect(a[0].version).toBe('1');
    writeFileSync(fp, '#!/bin/sh\necho 2\n');
    const b = await svc.list();
    expect(b[0].version).toBe(a[0].version);
    const c = await svc.list({ force: true });
    expect(c[0].version).toBe('2');
  }, TEST_TIMEOUT_MS);

  it('includes external bin entries with origin=external, sorted alongside builtins', async () => {
    const builtinDir = tmp();
    const a = path.join(builtinDir, 'apple');
    writeFileSync(a, '#!/bin/sh\necho a-1\n');
    chmodSync(a, 0o755);
    const externDir = tmp();
    const z = path.join(externDir, 'zinc');
    writeFileSync(z, '#!/bin/sh\necho z-7\n');
    chmodSync(z, 0o755);
    const m = path.join(externDir, 'mango');
    writeFileSync(m, '#!/bin/sh\necho m-3\n');
    chmodSync(m, 0o755);
    const externals: ExternalBinEntry[] = [
      { name: 'zinc', path: z, addedAt: '2026-01-01T00:00:00Z' },
      { name: 'mango', path: m, addedAt: '2026-01-02T00:00:00Z' },
    ];
    const svc = new ToolsService({
      binDir: () => builtinDir,
      ttlMs: 1000,
      spawnTimeoutMs: SPAWN_TIMEOUT_MS,
      externalBins: async () => externals,
    });
    const list = await svc.list();
    expect(list.map((t) => t.name)).toEqual(['apple', 'mango', 'zinc']);
    expect(list.find((t) => t.name === 'apple')?.origin).toBe('builtin');
    expect(list.find((t) => t.name === 'zinc')?.origin).toBe('external');
    expect(list.find((t) => t.name === 'mango')?.origin).toBe('external');
    expect(list.find((t) => t.name === 'mango')?.version).toBe('m-3');
  }, TEST_TIMEOUT_MS);

  it('external entry whose file is missing returns version=null but stays in list', async () => {
    const builtinDir = tmp();
    const externals: ExternalBinEntry[] = [
      { name: 'gone', path: '/no/such/path/gone', addedAt: '2026-01-01T00:00:00Z' },
    ];
    const svc = new ToolsService({
      binDir: () => builtinDir,
      ttlMs: 1000,
      externalBins: async () => externals,
    });
    const list = await svc.list();
    expect(list.map((t) => t.name)).toEqual(['gone']);
    expect(list[0].version).toBeNull();
    expect(list[0].origin).toBe('external');
  });
});

describe('ToolsService.addExternal', () => {
  it('rejects when no file picked (returns current list)', async () => {
    const builtinDir = tmp();
    const externals: ExternalBinEntry[] = [];
    let saved: ExternalBinEntry[] | null = null;
    const svc = new ToolsService({
      binDir: () => builtinDir,
      ttlMs: 1000,
      externalBins: async () => externals,
      setExternalBins: async (n) => { saved = n; },
      pickFile: async () => null,
    });
    const list = await svc.addExternal();
    expect(list).toEqual([]);
    expect(saved).toBeNull();
  });

  it('rejects non-executable file', async () => {
    const builtinDir = tmp();
    const dir = tmp();
    const fp = path.join(dir, 'plain.txt');
    writeFileSync(fp, 'just text');
    chmodSync(fp, 0o644);
    const svc = new ToolsService({
      binDir: () => builtinDir,
      ttlMs: 1000,
      externalBins: async () => [],
      setExternalBins: async () => {},
      pickFile: async () => fp,
    });
    await expect(svc.addExternal()).rejects.toThrow(/可执行/);
  });

  it('persists, returns updated list with origin=external', async () => {
    const builtinDir = tmp();
    const dir = tmp();
    const fp = path.join(dir, 'mybin');
    writeFileSync(fp, '#!/bin/sh\necho 9.9\n');
    chmodSync(fp, 0o755);
    let externals: ExternalBinEntry[] = [];
    const svc = new ToolsService({
      binDir: () => builtinDir,
      ttlMs: 1000,
      externalBins: async () => externals,
      setExternalBins: async (n) => { externals = n; },
      pickFile: async () => fp,
    });
    const list = await svc.addExternal();
    expect(externals).toHaveLength(1);
    expect(externals[0].name).toBe('mybin');
    expect(externals[0].path).toBe(fp);
    expect(list.map((t) => t.name)).toContain('mybin');
    expect(list.find((t) => t.name === 'mybin')?.origin).toBe('external');
  });

  it('rejects duplicate path', async () => {
    const builtinDir = tmp();
    const dir = tmp();
    const fp = path.join(dir, 'dup');
    writeFileSync(fp, '#!/bin/sh\necho 1\n');
    chmodSync(fp, 0o755);
    let externals: ExternalBinEntry[] = [{ name: 'dup', path: fp, addedAt: '2026-01-01T00:00:00Z' }];
    const svc = new ToolsService({
      binDir: () => builtinDir,
      ttlMs: 1000,
      externalBins: async () => externals,
      setExternalBins: async (n) => { externals = n; },
      pickFile: async () => fp,
    });
    await expect(svc.addExternal()).rejects.toThrow(/已添加/);
  });

  it('rejects name collision with builtin', async () => {
    const builtinDir = tmp();
    const builtinFp = path.join(builtinDir, 'fastpaper');
    writeFileSync(builtinFp, '#!/bin/sh\necho 1\n');
    chmodSync(builtinFp, 0o755);
    const dir = tmp();
    const fp = path.join(dir, 'fastpaper');
    writeFileSync(fp, '#!/bin/sh\necho 2\n');
    chmodSync(fp, 0o755);
    const svc = new ToolsService({
      binDir: () => builtinDir,
      ttlMs: 1000,
      externalBins: async () => [],
      setExternalBins: async () => {},
      pickFile: async () => fp,
    });
    await expect(svc.addExternal()).rejects.toThrow(/已存在/);
  });

  it('rejects name collision with another external', async () => {
    const builtinDir = tmp();
    const dirA = tmp();
    const dirB = tmp();
    const fpA = path.join(dirA, 'mytool');
    writeFileSync(fpA, '#!/bin/sh\necho 1\n');
    chmodSync(fpA, 0o755);
    const fpB = path.join(dirB, 'mytool');
    writeFileSync(fpB, '#!/bin/sh\necho 2\n');
    chmodSync(fpB, 0o755);
    let externals: ExternalBinEntry[] = [
      { name: 'mytool', path: fpA, addedAt: '2026-01-01T00:00:00Z' },
    ];
    const svc = new ToolsService({
      binDir: () => builtinDir,
      ttlMs: 1000,
      externalBins: async () => externals,
      setExternalBins: async (n) => { externals = n; },
      pickFile: async () => fpB,
    });
    await expect(svc.addExternal()).rejects.toThrow(/已存在/);
  });
});

describe('ToolsService.removeExternal', () => {
  it('filters the matching path from settings', async () => {
    const builtinDir = tmp();
    let externals: ExternalBinEntry[] = [
      { name: 'foo', path: '/x/foo', addedAt: '2026-01-01T00:00:00Z' },
      { name: 'bar', path: '/x/bar', addedAt: '2026-01-01T00:00:00Z' },
    ];
    const svc = new ToolsService({
      binDir: () => builtinDir,
      ttlMs: 1000,
      externalBins: async () => externals,
      setExternalBins: async (n) => { externals = n; },
    });
    await svc.removeExternal({ path: '/x/foo' });
    expect(externals.map((e) => e.name)).toEqual(['bar']);
  });

  it('throws skill.invalid when path not found', async () => {
    const builtinDir = tmp();
    const externals: ExternalBinEntry[] = [];
    const svc = new ToolsService({
      binDir: () => builtinDir,
      ttlMs: 1000,
      externalBins: async () => externals,
      setExternalBins: async () => {},
    });
    await expect(svc.removeExternal({ path: '/no/such' })).rejects.toThrow(/不存在/);
  });
});
