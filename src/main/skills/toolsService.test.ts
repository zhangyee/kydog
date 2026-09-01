// 夹具按平台分两套：POSIX 造 `#!/bin/sh` 脚本；win32 依产品的 .exe 分支造对应物——
// listExecutables 只认 .exe 后缀、addExternal 用后缀而非 mode 位判定可执行，
// 夹具必须踩在各自平台真实的判定路径上，断言的期望值由 makeSpawnable 一并给出。
import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, copyFileSync, linkSync, rmSync } from 'node:fs';
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

const IS_WIN = process.platform === 'win32';
const exeName = (name: string) => (IS_WIN ? `${name}.exe` : name);

// win32 上「真可执行且 --version 输出可预期」的程序只有一种便宜货：node.exe 自己
// （输出恰为 process.version）。几十 MB 的复制整个套件只做一次，各用例硬链进自己的
// 目录（都在 %TEMP% 里，同卷硬链必然可用；链不上再退化为复制）。
let nodeMasterDir: string | null = null;
let nodeMaster: string | null = null;
function nodeExeMaster(): string {
  if (!nodeMaster) {
    nodeMasterDir = tmp();
    nodeMaster = path.join(nodeMasterDir, 'node-master.exe');
    copyFileSync(process.execPath, nodeMaster);
  }
  return nodeMaster;
}
afterAll(() => {
  if (nodeMasterDir) rmSync(nodeMasterDir, { recursive: true, force: true });
});

/** 真可执行、--version 输出可预期的夹具；返回路径与期望的 version 值。 */
function makeSpawnable(dir: string, name: string, posixEcho: string): { fp: string; version: string } {
  const fp = path.join(dir, exeName(name));
  if (IS_WIN) {
    try { linkSync(nodeExeMaster(), fp); } catch { copyFileSync(nodeExeMaster(), fp); }
    return { fp, version: process.version };
  }
  writeFileSync(fp, `#!/bin/sh\necho ${posixEcho}\n`);
  chmodSync(fp, 0o755);
  return { fp, version: posixEcho };
}

/** 只需通过「是可执行文件」判定、内容无关的占位物；win32 上 spawn 它必败 → version=null。 */
function makeInert(dir: string, name: string): string {
  const fp = path.join(dir, exeName(name));
  if (IS_WIN) {
    writeFileSync(fp, 'not a real PE\n');
  } else {
    writeFileSync(fp, '#!/bin/sh\necho x\n');
    chmodSync(fp, 0o755);
  }
  return fp;
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
    const { fp, version } = makeSpawnable(dir, 'fastpaper', '1.4.0');
    const svc = new ToolsService({ binDir: () => dir, ttlMs: 1000, spawnTimeoutMs: SPAWN_TIMEOUT_MS });
    const list = await svc.list();
    expect(list[0].name).toBe('fastpaper');
    expect(list[0].version).toBe(version);
    expect(list[0].path).toBe(fp);
    expect(list[0].origin).toBe('builtin');
  }, TEST_TIMEOUT_MS);

  // timeout 分支本身是平台无关的纯 JS（定时器 + kill），POSIX/CI 已覆盖；
  // win32 造不出「可执行但赖着不退」的廉价夹具（waitfor.exe --version 也会立即退出），跳过。
  it.skipIf(IS_WIN)('handles --version timeout → version=null', async () => {
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
    const { fp, version: v1 } = makeSpawnable(dir, 'tool', '1');
    const svc = new ToolsService({
      binDir: () => dir,
      ttlMs: 1_000_000,
      spawnTimeoutMs: SPAWN_TIMEOUT_MS,
    });
    const a = await svc.list();
    expect(a[0].version).toBe(v1);
    // 换内容制造可观测的版本变化：POSIX 改写脚本输出；win32 没法让 .exe 换个输出，
    // 换成 spawn 必败的占位物 → 确定性地变成 null。
    let v2: string | null;
    if (IS_WIN) {
      rmSync(fp);
      makeInert(dir, 'tool');
      v2 = null;
    } else {
      writeFileSync(fp, '#!/bin/sh\necho 2\n');
      v2 = '2';
    }
    const b = await svc.list();
    expect(b[0].version).toBe(a[0].version);
    const c = await svc.list({ force: true });
    expect(c[0].version).toBe(v2);
  }, TEST_TIMEOUT_MS);

  it('includes external bin entries with origin=external, sorted alongside builtins', async () => {
    const builtinDir = tmp();
    makeInert(builtinDir, 'apple');
    const externDir = tmp();
    const z = makeInert(externDir, 'zinc');
    const { fp: m, version: mVersion } = makeSpawnable(externDir, 'mango', 'm-3');
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
    expect(list.find((t) => t.name === 'mango')?.version).toBe(mVersion);
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
    const fp = makeInert(dir, 'mybin');
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
    const fp = makeInert(dir, 'dup');
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
    makeInert(builtinDir, 'fastpaper');
    const dir = tmp();
    const fp = makeInert(dir, 'fastpaper');
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
    const fpA = makeInert(dirA, 'mytool');
    const fpB = makeInert(dirB, 'mytool');
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
